//! Portas do autofetch v3: as seis operações de
//! `adom_autofetch::v3::AutofetchDebrid` sobre os primitivos que já existem
//! neste crate, um adaptador por serviço e UMA interface para o worker.
//!
//! POR QUE O `impl` DO TRAIT NÃO ESTÁ AQUI: `adom-debrid` não pode depender de
//! `adom-autofetch` — o workspace fecha um ciclo duro de pacotes
//! (`adom-autofetch` → `adom-store` → `adom-search` → `adom-debrid`, ver
//! `crates/adom-search/Cargo.toml:12`) e o Cargo recusa "cyclic package
//! dependency". Este módulo entrega a implementação INTEIRA com a mesma forma
//! de dados do contrato (`autofetch_ports_contract`); o `impl` do trait mora
//! em `adom-server/src/autofetch` (fábrica por conta; `fakes.rs` já implementa
//! o trait com `Error = String`), que vê os dois crates, e é
//! `Box::pin(self.enqueue(..))` e companhia: seis métodos, zero regra de
//! negócio.
//!
//! Regras que não podem regredir:
//!
//! 1. A chave da API é do CONSTRUTOR (escopo `adapter:account`), nunca do
//!    `QueueCandidate`: o contrato só carrega hash, ids e o que o worker já
//!    sabe — nada de segredo no payload persistido.
//! 2. `unknown` nunca vira `dead`: hash pedido e não listado sai `unknown`
//!    (ausência no snapshot não é prova de morte — a janela de visibilidade é
//!    do serviço). Só estado explícito condena.
//! 3. Capacidade inexistente é desligada EXPLICITAMENTE (`PortError::
//!    Unsupported`), nunca "sucesso vazio". `evict` existe SÓ na AllDebrid
//!    (a conta lista `{id, hash}` e o delete é por id, com a guarda
//!    `may_delete`), atrás da env própria `DEBRID_AUTO_FETCH_EVICT_FALLBACK`;
//!    os outros quatro seguem `Unsupported`.
//! 4. Escrita incerta não é reenviada: o RD passa pelo `RealDebridAutofetch`
//!    (intent durável + gate COMPARTILHADO injetado pelo chamador). Esta porta
//!    NÃO cria executor novo — duas filas para a mesma conta fariam o AIMD
//!    mentir sobre gap/cooldown.
//! 5. `check` só diz `known:true` com prova de snapshot completo. Sem ledger
//!    (RD) ou sem checagem de cache (Debrid-Link) a resposta é `known:false`.
//!
//! Divisão dos arquivos: contrato de dados espelhado em
//! `autofetch_ports_contract.rs`, tipos/erro em `autofetch_ports_types.rs`,
//! `enqueue` + `check` + `remove` + `account` em `autofetch_ports_inner.rs`,
//! `evict` em `autofetch_ports_evict.rs` e `status` em
//! `autofetch_ports_status.rs` (catraca de 400 linhas).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

#[path = "autofetch_ports_contract.rs"]
mod contract;
pub use contract::{
    AccountEvidence, CacheEvidence, DebridFuture, EnqueueEvidence, EvictOutcome, PortCandidate,
    TorrentEvidence, TorrentProgress,
};

use crate::alldebrid::{AllDebrid, AutofetchState, Provenance};
use crate::debridlink::DebridLink;
use crate::premiumize::{Premiumize, TransferState};
use crate::rd_gate_executor::RdGateExecutor;
use crate::realdebrid::RealDebrid;
use crate::realdebrid_autofetch::{RdUncertainStore, RealDebridAutofetch};
use crate::torbox::TorBox;

#[path = "autofetch_ports_types.rs"]
mod types;
pub use types::{scope_of, Capabilities, PortError, Service};

#[path = "autofetch_ports_evict.rs"]
mod evict;
#[path = "autofetch_ports_inner.rs"]
mod inner;
#[path = "autofetch_ports_status.rs"]
mod state;

/// Fatos que o worker tem ANTES do enqueue da AllDebrid. A guarda `adrm` lê o
/// `cache.db` do Node em modo somente leitura; sem fonte legível nada é
/// enviado (fail-closed), como `EnqueueOutcome::GuardUnavailable`.
#[derive(Clone, Debug)]
pub struct AlldebridFacts {
    pub db_path: Option<PathBuf>,
    /// Snapshot PRONTO da conta que cobre o hash (inventário do chamador).
    pub inventory_ready: bool,
    /// `Unavailable` = sem prova; jamais afirma posse de magnet alheio.
    pub provenance: Provenance,
}

impl Default for AlldebridFacts {
    /// Sem `cache.db` e sem inventário: guarda ilegível, nenhuma posse provada.
    fn default() -> Self {
        Self {
            db_path: None,
            inventory_ready: false,
            provenance: Provenance::Unavailable,
        }
    }
}

/// Ledger RD do chamador: `Some(true)` hit, `Some(false)` miss, `None` sem
/// prova. O `complete` do peek é quem decide `known`.
pub type RdLedgerPeek = Arc<dyn Fn(&str) -> Option<bool> + Send + Sync>;

/// Primitivos RD já amarrados ao gate e ao intent do CHAMADOR.
pub struct RdPorts {
    manager: RealDebridAutofetch,
    torrents: Arc<RealDebrid>,
    /// Sem ledger o `check` responde sempre `known:false`.
    ledger: Option<RdLedgerPeek>,
    /// Espera entre os polls de `/torrents/info` (produção: 700 ms).
    pub poll_wait: Duration,
}

impl RdPorts {
    /// `gate` e `uncertain` vêm do chamador; passar o MESMO gate do play nativo
    /// é obrigatório para serializar a conta.
    pub fn new(
        torrents: Arc<RealDebrid>,
        gate: RdGateExecutor,
        uncertain: Arc<dyn RdUncertainStore>,
    ) -> Self {
        Self {
            manager: RealDebridAutofetch::new(gate, uncertain),
            torrents,
            ledger: None,
            poll_wait: Duration::from_millis(700),
        }
    }

    pub fn with_ledger(mut self, peek: RdLedgerPeek) -> Self {
        self.ledger = Some(peek);
        self
    }
}

enum Backend {
    AllDebrid {
        service: Arc<AllDebrid>,
        facts: AlldebridFacts,
    },
    TorBox(Arc<TorBox>),
    Premiumize(Arc<Premiumize>),
    RealDebrid(Arc<RdPorts>),
    DebridLink(Arc<DebridLink>),
}

/// A porta de UM serviço para UMA conta.
pub struct AutofetchPorts {
    service: Service,
    api_key: String,
    scope: String,
    backend: Backend,
    /// `transfer_id` → hash. O contrato chama `remove` só com o id; o RD precisa
    /// do hash para a prova de posse, então a porta aprende o par no `enqueue`
    /// e no `status` (que recebe `transfer_ids`).
    ids: Mutex<HashMap<String, String>>,
}

impl AutofetchPorts {
    pub fn alldebrid(
        service: Arc<AllDebrid>,
        api_key: impl Into<String>,
        facts: AlldebridFacts,
    ) -> Self {
        Self::build(
            Service::AllDebrid,
            api_key,
            Backend::AllDebrid { service, facts },
        )
    }

    pub fn torbox(service: Arc<TorBox>, api_key: impl Into<String>) -> Self {
        Self::build(Service::TorBox, api_key, Backend::TorBox(service))
    }

    pub fn premiumize(service: Arc<Premiumize>, api_key: impl Into<String>) -> Self {
        Self::build(Service::Premiumize, api_key, Backend::Premiumize(service))
    }

    pub fn realdebrid(ports: RdPorts, api_key: impl Into<String>) -> Self {
        Self::build(
            Service::RealDebrid,
            api_key,
            Backend::RealDebrid(Arc::new(ports)),
        )
    }

    pub fn debridlink(service: Arc<DebridLink>, api_key: impl Into<String>) -> Self {
        Self::build(Service::DebridLink, api_key, Backend::DebridLink(service))
    }

    fn build(service: Service, api_key: impl Into<String>, backend: Backend) -> Self {
        let api_key = api_key.into();
        Self {
            service,
            scope: scope_of(service, &api_key),
            api_key,
            backend,
            ids: Mutex::new(HashMap::new()),
        }
    }

    pub fn service(&self) -> Service {
        self.service
    }

    /// `adapter:account` — seguro para log e chave de gate (sem a chave).
    pub fn scope(&self) -> &str {
        &self.scope
    }

    pub fn capabilities(&self) -> Capabilities {
        Capabilities {
            enqueue: true,
            status: true,
            check: true,
            cache_known: self.cache_known(),
            remove: true,
            // `evict` só existe onde há prova de `hash -> id` (AllDebrid) e com
            // a env própria ligada; os outros quatro seguem desligados.
            evict: matches!(self.backend, Backend::AllDebrid { .. }) && evict::evict_enabled(),
            account: !matches!(self.backend, Backend::DebridLink(_)),
        }
    }

    fn cache_known(&self) -> bool {
        match &self.backend {
            Backend::DebridLink(_) => false,
            Backend::RealDebrid(ports) => ports.ledger.is_some(),
            _ => true,
        }
    }

    fn learn(&self, id: Option<&str>, hash: &str) {
        let Some(id) = id.filter(|id| !id.is_empty()) else {
            return;
        };
        let mut ids = self.ids.lock().unwrap_or_else(|err| err.into_inner());
        ids.insert(id.to_string(), hash.to_string());
    }

    fn hash_of_id(&self, id: &str) -> Option<String> {
        self.ids
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(id)
            .cloned()
    }

    fn remember(&self, evidence: &TorrentEvidence, hash: &str) {
        self.learn(evidence.transfer_id.as_deref(), hash);
    }
}

/// As seis operações do contrato, assinatura por assinatura. `Box::pin` aqui é
/// a única cerimônia que o `impl adom_autofetch::v3::AutofetchDebrid` do
/// chamador precisa repetir (ver o doc do módulo `contract`).
impl AutofetchPorts {
    pub fn enqueue<'a>(
        &'a self,
        candidate: &'a PortCandidate,
    ) -> DebridFuture<'a, EnqueueEvidence, PortError> {
        Box::pin(self.enqueue_inner(candidate))
    }

    pub fn status<'a>(
        &'a self,
        hashes: &'a [String],
        transfer_ids: &'a BTreeMap<String, String>,
    ) -> DebridFuture<'a, BTreeMap<String, TorrentEvidence>, PortError> {
        Box::pin(self.status_inner(hashes, transfer_ids))
    }

    pub fn check<'a>(&'a self, hashes: &'a [String]) -> DebridFuture<'a, CacheEvidence, PortError> {
        Box::pin(self.check_inner(hashes))
    }

    pub fn remove<'a>(&'a self, transfer_id: &'a str) -> DebridFuture<'a, bool, PortError> {
        Box::pin(self.remove_inner(transfer_id))
    }

    pub fn evict<'a>(&'a self, hashes: &'a [String]) -> DebridFuture<'a, EvictOutcome, PortError> {
        Box::pin(self.evict_inner(hashes))
    }

    pub fn account(&self) -> DebridFuture<'_, AccountEvidence, PortError> {
        Box::pin(self.account_inner())
    }
}

/// Aceite NEGADO: o hash não entrou na conta.
fn rejected() -> EnqueueEvidence {
    EnqueueEvidence {
        accepted: false,
        transfer_id: None,
    }
}

/// Hash pedido e não listado: `unknown`, preservando o id que o chamador já
/// conhece. `via_id` diz que a única identificação veio do id — não do hash.
fn unlisted(id: Option<&String>) -> TorrentEvidence {
    TorrentEvidence {
        state: "unknown".to_string(),
        stalled: false,
        transfer_id: id.cloned(),
        via_id: id.is_some(),
        progress: None,
    }
}

fn wanted_hashes(hashes: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(hashes.len());
    for hash in hashes {
        let hash = hash.trim().to_ascii_lowercase();
        if hash.is_empty() || out.contains(&hash) {
            continue;
        }
        out.push(hash);
    }
    out
}

fn alldebrid_state(state: &AutofetchState) -> &'static str {
    match state {
        AutofetchState::Ready => "ready",
        AutofetchState::Downloading => "downloading",
        AutofetchState::Dead => "dead",
        AutofetchState::Unknown => "unknown",
    }
}

fn premiumize_state(state: &TransferState) -> &'static str {
    match state {
        TransferState::Ready => "ready",
        TransferState::Downloading => "downloading",
        TransferState::Dead => "dead",
        TransferState::Unknown => "unknown",
    }
}

fn progress_of(progress: &crate::alldebrid::AutofetchProgress) -> TorrentProgress {
    TorrentProgress {
        bytes: Some(progress.bytes),
        total: Some(progress.total),
        speed: Some(progress.speed),
        seeders: Some(progress.seeders),
    }
}

/// `id` vem como string ou número; o delete usa texto.
fn scalar_id(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Id que não pode alterar o caminho HTTP (o adaptador repetiria o filtro, mas
/// a porta não deixa a chamada sair para descobrir).
fn safe_id(id: &str) -> bool {
    id.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn non_negative(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    value.round() as u64
}

#[cfg(test)]
#[path = "autofetch_ports_tests.rs"]
mod tests;
