//! O `applyDebrid` REAL — a implementação de [`DebridCheck`] que consome os
//! adaptadores do `adom-debrid` (`verdict::check_service`).
//!
//! A config (serviço + chave do debrid) vem do CALLER (config do usuário
//! decodificada da URL), nunca hardcoded. Erro de rede/serviço no caminho
//! local vira [`DebridAnswer::Unknown`] — nunca `Missing` (falso negativo é
//! pior: `known:false` deixa o passe tardio refazer).
//!
//! **Lote / memo:** `prepare` (ou a 1ª `check`) dispara UM `check_service`
//! com todos os hashes da busca; streams seguintes leem o memo. AllDebrid =
//! no máximo um `/magnet/upload` por busca.
//!
//! **AllDebrid nativa (incondicional desde a R3):** a checagem nativa responde
//! sempre — a antiga rota Node da checagem e a reserva que a chamava
//! saíram. Serviço fora do despacho local degrada para `Unknown` honesto
//! (nada de rodar o pipeline TS por baixo).
//!
//! **Feed de holds (AllDebrid):** o hold volátil do autofetch mora no Node, e a
//! limpeza nativa exige `holds_complete` + inventário. Com `DEBRID_AL_HOLDS=on`
//! (default OFF no código, ON no compose) o seam pergunta os fatos à rota
//! interna `/internal/debrid/holds` ANTES da checagem nativa e os entrega ao
//! `verdict`. Sem resposta, conta divergente ou cobertura incompleta a nativa
//! segue READ-ONLY — nunca "completa" por omissão. O feed só vale com
//! `DEBRID_AL_CLEANUP=on`.

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use adom_core::RankingStream;
use tokio::runtime::{Handle, Runtime};

use crate::list_builder::{DebridAnswer, DebridCheck};
use adom_debrid::alldebrid_cleanup::{account_scope, CleanupMode};
use adom_debrid::holds_feed::{HoldsFacts, InternalHoldsClient};
use adom_debrid::store::Store;
use adom_debrid::verdict::{self, CheckOutcome, ServiceCheck};

use crate::orchestrator::debrid_al_metrics;

/// Feed dos holds do autofetch (memória do Node) para a limpeza nativa da
/// AllDebrid. Implementação real = [`NodeHoldsFeed`] (rota interna); testes
/// injetam stub. Contrato: `encoded` + lote, sem apiKey (a chave mora no
/// `encoded`).
pub trait HoldsFeed: Send + Sync {
    fn facts(
        &self,
        encoded: &str,
        service: &str,
        hashes: &[String],
        deadline_at: Option<i64>,
    ) -> Result<HoldsFacts, String>;
}

/// Cliente HTTP real da rota `/internal/debrid/holds` (loopback + token +
/// prazo curto). Só existe com `DEBRID_AL_HOLDS=on`; sem a flag não há feed.
pub struct NodeHoldsFeed {
    client: InternalHoldsClient,
}

impl NodeHoldsFeed {
    /// Do ambiente (`INTERNAL_CHECK_URL` + token interno). `None` = flag OFF,
    /// sem token ou base fora do loopback — a nativa segue read-only.
    pub fn from_env() -> Option<Self> {
        Some(Self {
            client: InternalHoldsClient::from_env()?,
        })
    }
}

impl HoldsFeed for NodeHoldsFeed {
    fn facts(
        &self,
        encoded: &str,
        service: &str,
        hashes: &[String],
        deadline_at: Option<i64>,
    ) -> Result<HoldsFacts, String> {
        block_on(self.client.fetch(encoded, service, hashes, deadline_at))
    }
}

pub struct AdapterDebridCheck {
    pub service: String,
    pub api_key: String,
    /// Segmento de config do usuário: o feed de holds (e só ele) o usa.
    pub encoded: Option<String>,
    /// Prazo absoluto (epoch ms) da busca — o feed de holds o respeita.
    pub deadline_at: Option<i64>,
    /// Prazo da checagem local; `None` usa o default do adaptador.
    pub timeout: Option<Duration>,
    /// Ledger do RD (`rdc:v2`); `None` deixa todo hash `Unknown`.
    pub store: Option<std::sync::Arc<Store>>,
    /// Feed dos holds do autofetch (`DEBRID_AL_HOLDS`, default OFF no código e
    /// ON no compose). Só a AllDebrid com `DEBRID_AL_CLEANUP=on` o consulta.
    pub holds: Option<std::sync::Arc<dyn HoldsFeed>>,
    /// Stub de teste: substitui a checagem nativa (sem rede).
    #[cfg(test)]
    pub local_stub: Option<std::sync::Arc<dyn Fn() -> Result<ServiceCheck, String> + Send + Sync>>,
    /// Hashes do lote desta busca (preenchidos por `prepare`).
    batch_hashes: Vec<String>,
    /// Veredito único do lote. `None` = ainda não rodou.
    memo: Option<CheckOutcome>,
    /// Contagem de uploads/checks locais (teste: AD ≤ 1 por busca).
    local_checks: usize,
    /// Fatos do feed entregues à nativa nesta busca (teste).
    #[cfg(test)]
    last_facts: Option<HoldsFacts>,
}

impl AdapterDebridCheck {
    pub fn new(service: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            service: service.into(),
            api_key: api_key.into(),
            encoded: None,
            deadline_at: None,
            timeout: None,
            store: None,
            holds: None,
            #[cfg(test)]
            local_stub: None,
            batch_hashes: Vec::new(),
            memo: None,
            local_checks: 0,
            #[cfg(test)]
            last_facts: None,
        }
    }

    pub fn local_checks(&self) -> usize {
        self.local_checks
    }

    #[cfg(test)]
    pub fn last_facts(&self) -> Option<HoldsFacts> {
        self.last_facts.clone()
    }

    /// Dispara o lote se o memo ainda estiver vazio.
    fn ensure_memo(&mut self, extra: Option<&str>) {
        if self.memo.is_some() {
            return;
        }
        let mut hashes = self.batch_hashes.clone();
        if hashes.is_empty() {
            if let Some(h) = extra.filter(|h| !h.is_empty()) {
                hashes.push(h.to_string());
            }
        }
        if hashes.is_empty() {
            self.memo = Some(unknown_outcome());
            return;
        }
        // Dedupe estável (ordem da 1ª aparição).
        let mut seen = HashSet::new();
        hashes.retain(|h| seen.insert(h.to_lowercase()));

        // AllDebrid tem caminho próprio: a nativa e o feed de holds.
        if self.service == "alldebrid" {
            self.alldebrid_memo(&hashes);
            return;
        }

        if verdict::is_known_service(&self.service) {
            self.local_checks += 1;
            let outcome = block_on(verdict::check_service(
                &self.service,
                &self.api_key,
                &hashes,
                self.timeout,
                self.store.as_deref(),
            ));
            // Serviço conhecido: Ok(Unknown) em falha — nunca um segundo
            // caminho (re-upload caro/efeito colateral).
            self.memo = Some(match outcome {
                Ok(o) => o,
                Err(_) => unknown_outcome(),
            });
            return;
        }

        // Serviço fora do despacho local: `Unknown` honesto, sem reserva.
        self.memo = Some(unknown_outcome());
    }

    /// AllDebrid: a checagem nativa é o único caminho (incondicional desde a
    /// R3 — não há mais reserva Node).
    fn alldebrid_memo(&mut self, hashes: &[String]) {
        self.memo = Some(self.native_primary(hashes));
    }

    /// Resposta do caminho nativo.
    fn native_primary(&mut self, hashes: &[String]) -> CheckOutcome {
        // Fatos ANTES do upload: a nativa só apaga com a prova de cobertura do
        // lote. Falha/ausência = read-only.
        let facts = self.cleanup_facts(hashes);
        #[cfg(test)]
        {
            self.last_facts = facts.clone();
        }
        match self.run_local(hashes, facts.as_ref()) {
            Ok(check) => {
                debrid_al_metrics::note_native(&check);
                check.outcome
            }
            Err(_) => unknown_outcome(),
        }
    }

    /// Fatos do feed para ESTA busca. Condições, todas necessárias: AllDebrid,
    /// `DEBRID_AL_CLEANUP=on` (sem a flag os fatos não teriam uso), feed
    /// configurado e `encoded` presente. A conta do feed tem que ser a MESMA da
    /// checagem; a cobertura do lote é reconferida no `verdict`.
    fn cleanup_facts(&self, hashes: &[String]) -> Option<HoldsFacts> {
        if self.service != "alldebrid" {
            return None;
        }
        if !CleanupMode::from_env().is_on() {
            return None;
        }
        let feed = self.holds.as_ref()?;
        let encoded = self.encoded.as_deref().filter(|value| !value.is_empty())?;
        let facts = match feed.facts(encoded, &self.service, hashes, self.deadline_at) {
            Ok(facts) => facts,
            Err(error) => {
                debrid_al_metrics::note_holds_missing();
                eprintln!("[debrid] feed de holds indisponível: {error}");
                return None;
            }
        };
        // Conta diferente = fatos do outro usuário: nunca aproveitar.
        if facts.account != account_scope(&self.api_key) {
            debrid_al_metrics::note_holds_account_mismatch();
            return None;
        }
        if facts.covers(hashes) {
            debrid_al_metrics::note_holds_ok();
        } else {
            debrid_al_metrics::note_holds_incomplete();
        }
        Some(facts)
    }

    /// Checagem nativa do lote. O stub de teste evita rede.
    fn run_local(
        &mut self,
        hashes: &[String],
        facts: Option<&HoldsFacts>,
    ) -> Result<ServiceCheck, String> {
        self.local_checks += 1;
        #[cfg(test)]
        if let Some(stub) = self.local_stub.clone() {
            let _ = facts;
            return stub();
        }
        block_on(verdict::check_service_report_with(
            &self.service,
            &self.api_key,
            hashes,
            self.timeout,
            self.store.as_deref(),
            facts,
        ))
    }
}

impl DebridCheck for AdapterDebridCheck {
    fn prepare(&mut self, hashes: &[String]) {
        self.batch_hashes = hashes.iter().filter(|h| !h.is_empty()).cloned().collect();
        self.ensure_memo(None);
    }

    fn check(&mut self, stream: &RankingStream) -> DebridAnswer {
        let Some(hash) = stream.info_hash.as_deref().filter(|h| !h.is_empty()) else {
            return DebridAnswer::Unknown;
        };
        self.ensure_memo(Some(hash));
        match self.memo.as_ref() {
            Some(outcome) => answer_of(outcome, hash),
            None => DebridAnswer::Unknown,
        }
    }
}

/// `Unknown` honesto: sem resposta fechada não há `Missing`.
fn unknown_outcome() -> CheckOutcome {
    CheckOutcome {
        cached: Vec::new(),
        known: false,
        unusable: None,
    }
}

/// Veredito já obtido → resposta do build (`list_builder::DebridAnswer`).
/// Unusable vence (a conta não vai responder). Hit parcial / timeout de
/// lote (`known:false` com hashes em `cached`) mantém ⚡ nos confirmados —
/// espelha o Node (`debrid-pipeline-core`: `materialize` olha o Set, não o
/// flag). Só o que NÃO está em `cached` vira Unknown quando `!known`
/// (nunca Missing: falso negativo é pior). O ⚡ NÃO monta url aqui — o play
/// decide o arquivo (a fatia de resposta monta o `/resolve` relativo com HMAC).
pub fn answer_of(outcome: &CheckOutcome, hash: &str) -> DebridAnswer {
    if outcome.unusable.is_some() {
        return DebridAnswer::Unusable;
    }
    // Confirmado em cache vence o flag do lote: hit parcial / timeout
    // preserva ⚡ nos que o serviço nomeou (núcleo: `debrid_cache_verdict`).
    if verdict::is_cached(outcome, hash) {
        return DebridAnswer::Cached { url: None };
    }
    if !outcome.known {
        return DebridAnswer::Unknown;
    }
    DebridAnswer::Missing
}

/// `block_on` que funciona dentro e fora de runtime tokio.
///
/// `finish` / `DebridCheck` são síncronos e rodam no meio de `run_search`
/// (async). `Handle::block_on` **panica** nesse contexto — por isso
/// `block_in_place` (runtime multi-thread do gateway) libera o worker
/// enquanto o futuro da checagem corre. Fora de runtime, o estático basta.
fn block_on<F: Future>(fut: F) -> F::Output {
    match Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(fut)),
        Err(_) => static_runtime().block_on(fut),
    }
}

fn static_runtime() -> &'static Runtime {
    static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime do debrid")
    });
    &RUNTIME
}

use std::future::Future;

#[cfg(test)]
#[path = "debrid_seam_tests.rs"]
mod debrid_seam_tests;
