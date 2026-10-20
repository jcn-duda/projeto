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
//! no máximo um `/magnet/upload` por busca — NUNCA segundo upload no
//! fallback.
//!
//! **Fallback Node:** quando o serviço ainda não está no despacho local
//! (`unknown_service`), quando não há reserva configurada e, com
//! `DEBRID_AL_RUST=off` (default), SEMPRE para a AllDebrid. Com a flag em
//! `on`, a AllDebrid usa a checagem nativa do `adom-debrid` e só cai no Node
//! quando NENHUM upload foi enviado (base recusada/sem lote) — repetir depois
//! de um upload real dobraria o lixo na conta. Com `shadow`, a nativa
//! responde e o Node é chamado como REFERÊNCIA em fundo
//! (`debrid.al.shadow.*`), sem segurar o cliente.

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use adom_core::RankingStream;
use tokio::runtime::{Handle, Runtime};

use crate::list_builder::{DebridAnswer, DebridCheck};
use adom_debrid::alldebrid_mode::AlRustMode;
use adom_debrid::internal_check::InternalCheckClient;
use adom_debrid::store::Store;
use adom_debrid::verdict::{self, CheckOutcome, ServiceCheck};

use crate::orchestrator::debrid_shadow;

/// A RESERVA: quem responde quando o caminho local NÃO PÔDE (serviço ainda
/// fora do despacho). Implementação real = `NodeInternalFallback`; testes
/// injetam stub. Contrato Node: `encoded` + `deadline_at`, sem apiKey.
pub trait FallbackCheck: Send + Sync {
    fn check(
        &self,
        encoded: &str,
        service: &str,
        hashes: &[String],
        deadline_at: i64,
    ) -> Result<CheckOutcome, String>;
}

/// Cliente HTTP real da rota `/internal/debrid/check` do Node (loopback +
/// token + prazo).
pub struct NodeInternalFallback {
    client: InternalCheckClient,
}

impl NodeInternalFallback {
    /// Do ambiente (`INTERNAL_CHECK_URL` + `DEBRID_INTERNAL_TOKEN`).
    /// `None` = sem token — não há reserva a fazer.
    pub fn from_env() -> Option<Self> {
        Some(Self {
            client: InternalCheckClient::from_env()?,
        })
    }
}

impl FallbackCheck for NodeInternalFallback {
    fn check(
        &self,
        encoded: &str,
        service: &str,
        hashes: &[String],
        deadline_at: i64,
    ) -> Result<CheckOutcome, String> {
        block_on(self.client.check(encoded, service, hashes, deadline_at))
    }
}

pub struct AdapterDebridCheck {
    pub service: String,
    pub api_key: String,
    /// Segmento de config do usuário (corpo da rota Node). Sem ele a reserva
    /// não dispara.
    pub encoded: Option<String>,
    /// Prazo absoluto (epoch ms) da busca — mesmo `deadline_at` da rota Node.
    pub deadline_at: Option<i64>,
    /// Prazo da checagem local; `None` usa o default do adaptador.
    pub timeout: Option<Duration>,
    /// Ledger do RD (`rdc:v2`); `None` deixa todo hash `Unknown`.
    pub store: Option<std::sync::Arc<Store>>,
    /// Reserva só para serviço fora do despacho local.
    pub fallback: Option<std::sync::Arc<dyn FallbackCheck>>,
    /// `DEBRID_AL_RUST` (default OFF). Só a AllDebrid lê este campo.
    pub mode: AlRustMode,
    /// Stub de teste: substitui a checagem nativa (sem rede).
    #[cfg(test)]
    pub local_stub: Option<std::sync::Arc<dyn Fn() -> Result<ServiceCheck, String> + Send + Sync>>,
    /// Hashes do lote desta busca (preenchidos por `prepare`).
    batch_hashes: Vec<String>,
    /// Veredito único do lote (local ou reserva). `None` = ainda não rodou.
    memo: Option<CheckOutcome>,
    /// Contagem de uploads/checks locais (teste: AD ≤ 1 por busca).
    local_checks: usize,
    /// Contagem de chamadas à reserva (teste: 0 para serviço conhecido).
    fallback_checks: usize,
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
            fallback: None,
            mode: AlRustMode::Off,
            #[cfg(test)]
            local_stub: None,
            batch_hashes: Vec::new(),
            memo: None,
            local_checks: 0,
            fallback_checks: 0,
        }
    }

    pub fn local_checks(&self) -> usize {
        self.local_checks
    }

    pub fn fallback_checks(&self) -> usize {
        self.fallback_checks
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

        // AllDebrid tem caminho próprio: `DEBRID_AL_RUST=off` mantém a reserva
        // Node (default); `on` usa a nativa com fallback só pré-upload;
        // `shadow` usa a nativa e compara o Node em fundo.
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
            // Serviço conhecido: Ok(Unknown) em falha — NUNCA fallback
            // (re-upload caro/efeito colateral).
            self.memo = Some(match outcome {
                Ok(o) => o,
                Err(_) => unknown_outcome(),
            });
            return;
        }

        // Serviço fora do despacho local → reserva Node (um lote).
        self.memo = Some(self.run_fallback(&hashes).unwrap_or_else(unknown_outcome));
    }

    /// AllDebrid: a flag decide quem responde. `off` é o caminho Node de
    /// sempre; `on` usa a nativa; `shadow` usa a nativa e compara o Node em
    /// fundo (a resposta do cliente é a nativa, como no caminho vivo).
    fn alldebrid_memo(&mut self, hashes: &[String]) {
        match self.mode {
            AlRustMode::Off => {
                if self.fallback_ready() {
                    // Reserva que falhou vira "não sei", NUNCA o local: o Node
                    // pode já ter feito o upload, e um segundo dobraria o lixo
                    // na conta (contrato anterior preservado).
                    self.memo = Some(self.run_fallback(hashes).unwrap_or_else(unknown_outcome));
                } else {
                    self.memo = Some(self.local_outcome(hashes));
                }
            }
            AlRustMode::On => {
                let (outcome, _) = self.native_primary(hashes);
                self.memo = Some(outcome);
            }
            AlRustMode::Shadow => {
                let (outcome, native) = self.native_primary(hashes);
                if let Some(native) = native {
                    if self.fallback_ready() {
                        self.spawn_shadow(hashes, native);
                    }
                }
                self.memo = Some(outcome);
            }
        }
    }

    /// Resposta do caminho nativo + o veredito nativo (se ele existiu). A
    /// nativa só perde para o Node quando NADA foi enviado — o mesmo contrato
    /// do modo `on`.
    fn native_primary(&mut self, hashes: &[String]) -> (CheckOutcome, Option<ServiceCheck>) {
        match self.run_local(hashes) {
            // Veredito fechado OU upload já enviado: não repetir no Node.
            Ok(check) if check.attempted || check.outcome.known => {
                debrid_shadow::note_native(&check);
                (check.outcome.clone(), Some(check))
            }
            // Nada foi enviado (base recusada/lista vazia): o Node pode
            // responder sem risco de segundo upload.
            Ok(check) if self.fallback_ready() => {
                debrid_shadow::note_fallback();
                (self.run_fallback(hashes).unwrap_or(check.outcome), None)
            }
            Ok(check) => (check.outcome, None),
            Err(_) if self.fallback_ready() => {
                debrid_shadow::note_fallback();
                (
                    self.run_fallback(hashes).unwrap_or_else(unknown_outcome),
                    None,
                )
            }
            Err(_) => (unknown_outcome(), None),
        }
    }

    /// Checagem nativa do lote. O stub de teste evita rede.
    fn run_local(&mut self, hashes: &[String]) -> Result<ServiceCheck, String> {
        self.local_checks += 1;
        #[cfg(test)]
        if let Some(stub) = self.local_stub.clone() {
            return stub();
        }
        block_on(verdict::check_service_report(
            &self.service,
            &self.api_key,
            hashes,
            self.timeout,
            self.store.as_deref(),
        ))
    }

    fn local_outcome(&mut self, hashes: &[String]) -> CheckOutcome {
        match self.run_local(hashes) {
            Ok(check) => {
                debrid_shadow::note_native(&check);
                check.outcome
            }
            Err(_) => unknown_outcome(),
        }
    }

    /// A referência Node roda em thread própria; o cliente já recebeu a
    /// nativa. O conjunto comparado é limitado por
    /// `DEBRID_AL_SHADOW_MAX_HASHES`.
    fn spawn_shadow(&mut self, hashes: &[String], native: ServiceCheck) {
        let Some(fallback) = self.fallback.clone() else {
            return;
        };
        let Some(encoded) = self.encoded.clone().filter(|s| !s.is_empty()) else {
            return;
        };
        // A referência roda depois da resposta: o deadline da busca já pode
        // ter vencido, então ela ganha o próprio prazo.
        let deadline_at = debrid_shadow::fresh_deadline_ms();
        let probe = debrid_shadow::probe_hashes(hashes);
        if probe.is_empty() {
            return;
        }
        let service = self.service.clone();
        let probe_for_call = probe.clone();
        debrid_shadow::spawn(debrid_shadow::ReferenceConfig {
            native: native.outcome,
            hashes: probe,
            reference: Box::new(move || {
                fallback.check(&encoded, &service, &probe_for_call, deadline_at)
            }),
        });
    }

    /// A reserva Node tem tudo para ser chamada (cliente, usuário e prazo).
    fn fallback_ready(&self) -> bool {
        self.fallback.is_some()
            && self.encoded.as_deref().is_some_and(|s| !s.is_empty())
            && self.deadline_at.is_some_and(|d| d > 0)
    }

    fn run_fallback(&mut self, hashes: &[String]) -> Option<CheckOutcome> {
        let fb = self.fallback.as_ref()?;
        let encoded = self.encoded.as_deref().filter(|s| !s.is_empty())?;
        let deadline_at = self.deadline_at.filter(|d| *d > 0)?;
        self.fallback_checks += 1;
        fb.check(encoded, &self.service, hashes, deadline_at).ok()
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
