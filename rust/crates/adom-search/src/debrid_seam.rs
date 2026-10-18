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
//! **Fallback Node:** só quando o serviço ainda não está no despacho local
//! (`unknown_service`). Serviço conhecido que devolveu `Ok(Unknown)` NÃO
//! cai na reserva (evita re-upload AD e falso "perguntar de novo").

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use adom_core::RankingStream;
use tokio::runtime::{Handle, Runtime};

use crate::list_builder::{DebridAnswer, DebridCheck};
use adom_debrid::internal_check::InternalCheckClient;
use adom_debrid::store::Store;
use adom_debrid::verdict::{self, CheckOutcome};

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
            self.memo = Some(CheckOutcome {
                cached: Vec::new(),
                known: false,
                unusable: None,
            });
            return;
        }
        // Dedupe estável (ordem da 1ª aparição).
        let mut seen = HashSet::new();
        hashes.retain(|h| seen.insert(h.to_lowercase()));

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
            // (AllDebrid não re-upload).
            self.memo = Some(match outcome {
                Ok(o) => o,
                Err(_) => CheckOutcome {
                    cached: Vec::new(),
                    known: false,
                    unusable: None,
                },
            });
            return;
        }

        // Serviço fora do despacho local → reserva Node (um lote).
        self.memo = Some(self.run_fallback(&hashes).unwrap_or(CheckOutcome {
            cached: Vec::new(),
            known: false,
            unusable: None,
        }));
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

/// `block_on` que funciona dentro e fora de runtime tokio. Dentro de worker
/// async a trait síncrona não deve ser usada; se estiver, o `Handle` é a
/// melhor tentativa (a build real roda em `spawn_blocking` / fora de async).
fn block_on<F: Future>(fut: F) -> F::Output {
    match Handle::try_current() {
        Ok(handle) => handle.block_on(fut),
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
