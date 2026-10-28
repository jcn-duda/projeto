//! Adaptador do worker nativo sobre as PORTAS do `adom-debrid` e a fábrica por
//! conta.
//!
//! # Por que o `impl` do trait mora aqui
//!
//! `adom-debrid` não pode depender de `adom-autofetch` (ciclo de pacotes:
//! `adom-autofetch` → `adom-store` → `adom-search` → `adom-debrid`), então a
//! implementação inteira das seis operações vive lá
//! (`adom_debrid::autofetch_ports::AutofetchPorts`) com o contrato de dados
//! ESPELHADO. Este módulo é a cola, e é só isso: converte os tipos espelhados
//! para `adom_autofetch::v3` e mapeia `PortError` → `String`. Zero regra de
//! negócio aqui — quem decide cache, morte, posse e capacidade é a porta.
//!
//! # As três regras desta cola
//!
//! 1. **A chave vem do cofre, nunca do payload.** [`DebridIo`] nasce com a
//!    chave que a [fábrica](factory) leu de [`Vault::key`] no momento do uso; o
//!    `QueueCandidate` só carrega hash/ids e a dica de obra (`season`,
//!    `episode`, `dubbed`).
//! 2. **Taxonomia no PREFIXO do erro.** `PortError::kind()` vira o prefixo
//!    (`quarantined:`, `cooldown:`, `unsupported:`, `invalid_input:`, `auth:`,
//!    `rate_limit:`, ...) e o `Display` vai atrás, para nenhuma recusa perder o
//!    motivo ao virar `String`. Essas strings podem chegar ao `lastError` do
//!    painel e ao log do laço — por isso o prefixo é taxonomia fechada e o corpo
//!    é a mensagem do serviço (nunca a chave).
//! 3. **Sem chave = SKIP, nunca recusa do lote.** A fábrica devolve `None` para
//!    escopo sem chave viva (cofre expirado, serviço não atendido) e quem chama
//!    PULA o passo; um escopo sem cofre não derruba o lote dos outros.
//!
//! `evict` segue desligado nos cinco serviços (a porta responde
//! `unsupported: evict`): o `String` de erro é o que impede a lista vazia de
//! virar "nada a apagar".

use std::collections::BTreeMap;
use std::sync::Arc;

use adom_autofetch::v3::{
    AccountEvidence, AutofetchDebrid, CacheEvidence, DebridFuture, EnqueueEvidence, QueueCandidate,
    TorrentEvidence, TorrentProgress,
};
use adom_debrid::autofetch_ports as ports;
use adom_debrid::{Capabilities, PortCandidate, PortError, Service};

use super::vault::Vault;

/// Adaptador de debrid já vinculado a UMA conta por quem o construiu.
pub(crate) type DebridIo = Arc<dyn AutofetchDebrid<Error = String>>;

/// Fábrica por CONTA: `adapter:sha256(chave)` → adaptador. O laço chama isto a
/// cada passo e nunca guarda o resultado entre lotes; a chave é lida do cofre
/// no momento do uso.
pub(crate) type DebridFactory = Arc<dyn Fn(&str) -> Option<DebridIo> + Send + Sync>;

/// Monta o adaptador de UMA conta: `(serviço, chave, escopo)`. `None` = este
/// serviço não é atendido pelo processo (o passo é pulado).
pub(crate) type AdapterBuilder = Arc<dyn Fn(&str, &str, &str) -> Option<DebridIo> + Send + Sync>;

/// Relógio injetável — o TTL do cofre é lido por ele.
pub(crate) type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// A porta de um serviço embrulhada no trait do worker.
pub(crate) struct PortedDebrid {
    ports: Arc<ports::AutofetchPorts>,
}

impl PortedDebrid {
    pub(crate) fn new(ports: Arc<ports::AutofetchPorts>) -> Self {
        Self { ports }
    }

    /// `adapter:sha256(chave)` — seguro para log (sem a chave).
    pub(crate) fn scope(&self) -> &str {
        self.ports.scope()
    }

    pub(crate) fn service(&self) -> Service {
        self.ports.service()
    }

    /// O que a porta REALMENTE sabe fazer (`evict` é `false` nos cinco).
    pub(crate) fn capabilities(&self) -> Capabilities {
        self.ports.capabilities()
    }
}

impl AutofetchDebrid for PortedDebrid {
    type Error = String;

    fn enqueue<'a>(
        &'a self,
        candidate: &'a QueueCandidate,
    ) -> DebridFuture<'a, EnqueueEvidence, String> {
        Box::pin(async move {
            let ported = port_candidate(candidate);
            self.ports
                .enqueue(&ported)
                .await
                .map(enqueue_evidence)
                .map_err(error_of)
        })
    }

    fn status<'a>(
        &'a self,
        hashes: &'a [String],
        transfer_ids: &'a BTreeMap<String, String>,
    ) -> DebridFuture<'a, BTreeMap<String, TorrentEvidence>, String> {
        Box::pin(async move {
            let statuses = self
                .ports
                .status(hashes, transfer_ids)
                .await
                .map_err(error_of)?;
            Ok(statuses
                .into_iter()
                .map(|(hash, evidence)| (hash, torrent_evidence(evidence)))
                .collect())
        })
    }

    fn check<'a>(&'a self, hashes: &'a [String]) -> DebridFuture<'a, CacheEvidence, String> {
        Box::pin(async move {
            self.ports
                .check(hashes)
                .await
                .map(cache_evidence)
                .map_err(error_of)
        })
    }

    fn remove<'a>(&'a self, transfer_id: &'a str) -> DebridFuture<'a, bool, String> {
        Box::pin(async move { self.ports.remove(transfer_id).await.map_err(error_of) })
    }

    fn evict<'a>(&'a self, hashes: &'a [String]) -> DebridFuture<'a, Vec<String>, String> {
        Box::pin(async move { self.ports.evict(hashes).await.map_err(error_of) })
    }

    fn account(&self) -> DebridFuture<'_, AccountEvidence, String> {
        Box::pin(async move {
            self.ports
                .account()
                .await
                .map(account_evidence)
                .map_err(error_of)
        })
    }
}

/// Fábrica do worker: lê a chave do cofre AGORA e delega ao `build`. Escopo sem
/// chave viva (expirada, esquecida, LRU) ou fora da forma `adapter:conta`
/// devolve `None` — o passo é pulado, não é erro.
pub(crate) fn factory(vault: Arc<Vault>, build: AdapterBuilder) -> DebridFactory {
    factory_at(vault, build, Arc::new(adom_sources::now_ms))
}

/// Igual a [`factory`], com relógio injetado (o teste prova o TTL do cofre no
/// MEIO do lote sem dormir).
pub(crate) fn factory_at(vault: Arc<Vault>, build: AdapterBuilder, clock: Clock) -> DebridFactory {
    Arc::new(move |scope: &str| {
        let (service, account) = scope.split_once(':')?;
        if service.is_empty() || account.is_empty() {
            return None;
        }
        let api_key = vault.key(scope, clock())?;
        build(service, &api_key, scope)
    })
}

/// `QueueCandidate` → o mínimo que a porta precisa. A dica de obra é a da fila
/// (`season`/`episode` do candidato, `dubbed` marcado), NUNCA a chave.
fn port_candidate(candidate: &QueueCandidate) -> PortCandidate {
    PortCandidate {
        hash: candidate.info_hash.trim().to_ascii_lowercase(),
        season: candidate.season_i64(),
        episode: candidate.episode_i64(),
        dubbed: candidate.dubbed == Some(true),
    }
}

fn enqueue_evidence(of: ports::EnqueueEvidence) -> EnqueueEvidence {
    EnqueueEvidence {
        accepted: of.accepted,
        transfer_id: of.transfer_id,
    }
}

fn cache_evidence(of: ports::CacheEvidence) -> CacheEvidence {
    CacheEvidence {
        known: of.known,
        cached: of.cached,
    }
}

fn torrent_evidence(of: ports::TorrentEvidence) -> TorrentEvidence {
    TorrentEvidence {
        state: of.state,
        stalled: of.stalled,
        transfer_id: of.transfer_id,
        via_id: of.via_id,
        progress: of.progress.map(progress_of),
    }
}

fn progress_of(of: ports::TorrentProgress) -> TorrentProgress {
    TorrentProgress {
        bytes: of.bytes,
        total: of.total,
        speed: of.speed,
        seeders: of.seeders,
    }
}

fn account_evidence(of: ports::AccountEvidence) -> AccountEvidence {
    AccountEvidence {
        used: of.used,
        max: of.max,
    }
}

/// `PortError` → `String` com a taxonomia NO PREFIXO e o motivo atrás.
///
/// `kind()` é a régua do crate (`quarantined`, `cooldown`, `unsupported`,
/// `invalid_input`, `store_unavailable`, `task_failed`, `auth`, `quota`,
/// `rate_limit`, `blocked`, ...); o `Display` preserva o motivo do serviço.
fn error_of(error: PortError) -> String {
    format!("{}: {error}", error.kind())
}

#[cfg(test)]
#[path = "ports_tests.rs"]
mod tests;
