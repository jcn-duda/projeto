//! Aquecimento do Real-Debrid no gateway (`rd_warmer`).
//!
//! O orquestrador (`adom_search`) decide QUAIS hashes aquecer e entrega o efeito
//! já montado (`{ releases: [{ title, infoHash, isBr, dubbed }] }`); este módulo
//! é o dono da EXECUÇÃO, no mesmo desenho do `dub_audit` (T3-L7a).
//!
//! # Régua portada de `src/providers/rd-warmer.ts`
//!
//! 1. `queueRdWarmForRelevant`: pontua 80 (BR + dublado), 40 (dublado) e 5
//!    (resto), deduplica por hash guardando o MAIOR score e corta em 10 hashes
//!    por efeito;
//! 2. `enqueue`: descarta o que o ledger `rdc:v2` já conhece (`hit`/`blocked`),
//!    deduplica a fila e respeita `DEBRID_RD_WARM_QUEUE_MAX`;
//! 3. `processBatch`: sonda em lotes de `DEBRID_RD_WARM_BATCH`, com teto por
//!    hora civil (`DEBRID_RD_WARM_MAX_HOUR`), pulando hash `bad` do magnetdb e
//!    registrando `noteHit`/`noteMiss`/`noteBlocked` no ledger — a ÚNICA fonte
//!    do ⚡ do RD no veredito nativo;
//! 4. rate limit/quota NÃO ganham backoff paralelo: cooldown e quarentena são
//!    do `RdGateExecutor` (`adom-debrid`) e o lote para no primeiro sinal.
//!
//! # Fase 1: estado durável e dono único
//!
//! Fila e quota usam as MESMAS chaves do Node (`rdq:v1:wq`, `rdq:v1:hour`), então
//! o primeiro boot lê o que o Node deixou — sem migração. O intent passou a ser
//! durável (`rdq:v1:uncertain:`), a drenagem só acontece na janela ociosa de
//! `DEBRID_RD_WARM_IDLE_WINDOW_MS` e o gate AIMD é o MESMO do autofetch.
//!
//! A drenagem é fire-and-forget: [`Warmer::offer`] só empurra para a fila e
//! devolve; quem publica nunca espera HTTP.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;

#[path = "rd_warmer_sink.rs"]
mod sink;
use sink::is_rd_scope;

#[path = "rd_warmer_store.rs"]
mod store;
#[allow(unused_imports)]
pub(crate) use store::{NativeQueue, RamQueue, WarmIntentStore, WarmItem, WarmQueue};

#[path = "rd_warmer_magnet.rs"]
mod magnet;
pub(crate) use magnet::{NoMagnet, WarmMagnet};

/// Kind que este módulo consome.
pub(crate) const RD_WARMER: &str = "rd_warmer";
/// Teto de hashes por efeito (o corte de `queueRdWarmForRelevant`).
pub(crate) const PER_EFFECT_MAX: usize = 10;
const SCORE_BR_DUBBED: i64 = 80;
const SCORE_DUBBED: i64 = 40;
const SCORE_OTHER: i64 = 5;
const HOUR_MS: i64 = 3_600_000;

/// O que a sonda provou sobre um hash.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WarmSignal {
    /// Está em cache (`downloaded` no RD).
    Hit,
    /// Não está (ou evidência insuficiente).
    Miss,
    /// O serviço bloqueou a release: cobre hit e miss no ledger.
    Blocked,
}

/// O que o ledger `rdc:v2` já sabe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LedgerMark {
    Hit,
    Blocked,
    /// `miss`, `unknown` ou ledger desligado: ainda vale sondar.
    Other,
}

#[derive(Default, Debug)]
pub(crate) struct WarmReport {
    /// Só o que virou PROVA. Hash sem sinal não mexeu no ledger.
    pub(crate) signals: Vec<(String, WarmSignal)>,
    /// Quantos hashes a porta chegou a sondar (o resto volta para a fila).
    pub(crate) attempted: usize,
    /// O gate mandou parar (cooldown, quarentena, rate limit, quota).
    pub(crate) stopped: bool,
}

pub(crate) type WarmFuture<'a> = Pin<Box<dyn Future<Output = WarmReport> + Send + 'a>>;

/// Sonda de cache. Produção é o `GateWarm` (`RealDebridAutofetch` + gate AIMD);
/// o teste injeta um duplo que conta chamadas.
pub(crate) trait WarmPort: Send + Sync {
    fn warm<'a>(&'a self, api_key: &'a str, hashes: &'a [String]) -> WarmFuture<'a>;
}

/// Chave da conta, lida do cofre/operador no momento do uso. NUNCA vem do
/// payload do efeito.
pub(crate) trait WarmKey: Send + Sync {
    fn rd_key(&self, scope: &str, now_ms: i64) -> Option<String>;

    /// Escopo do operador (`.env`/painel), adotado por entradas vindas do Node
    /// — a fila antiga não guardava conta. `None` = sem conta de operador.
    fn default_scope(&self, _now_ms: i64) -> Option<String> {
        None
    }

    /// Origem da credencial para o painel: `panel`, `env`, `sessao` ou `none`.
    fn account_source(&self, _now_ms: i64) -> &'static str {
        "none"
    }
}

/// Ledger `rdc:v2` (leitura para pular, escrita para o ⚡).
pub(crate) trait WarmLedger: Send + Sync {
    fn state(&self, hash: &str, now_ms: i64) -> LedgerMark;
    fn note(&self, hash: &str, signal: WarmSignal, now_ms: i64);
}

#[path = "rd_warmer_status.rs"]
mod status;
#[allow(unused_imports)]
pub(crate) use status::{Counters, WarmStatus};

#[derive(Default)]
struct State {
    queue: VecDeque<WarmItem>,
    hour: i64,
    per_hour: i64,
    in_flight: bool,
    counters: Counters,
}

struct Inner {
    config: WarmConfig,
    key: Arc<dyn WarmKey>,
    port: Arc<dyn WarmPort>,
    ledger: Arc<dyn WarmLedger>,
    magnet: Arc<dyn WarmMagnet>,
    queue: Arc<dyn WarmQueue>,
    traffic: Option<crate::harvest::StreamTraffic>,
    state: Mutex<State>,
    paused: AtomicBool,
    last_tick_at: AtomicI64,
    ticker_started: AtomicBool,
}

/// Peças de produção injetadas no boot (e trocadas por duplos no teste).
pub(crate) struct WarmDeps {
    pub(crate) config: WarmConfig,
    pub(crate) key: Arc<dyn WarmKey>,
    pub(crate) port: Arc<dyn WarmPort>,
    pub(crate) ledger: Arc<dyn WarmLedger>,
    pub(crate) magnet: Arc<dyn WarmMagnet>,
    pub(crate) queue: Arc<dyn WarmQueue>,
    pub(crate) traffic: Option<crate::harvest::StreamTraffic>,
}

/// Fila em RAM + dedupe + teto + persistência. Barato de publicar, caro só na
/// drenagem.
pub(crate) struct Warmer {
    inner: Arc<Inner>,
}

impl Warmer {
    /// Construtor dos testes antigos: sem persistência, magnetdb ou freio.
    #[allow(dead_code)]
    pub(crate) fn new(
        config: WarmConfig,
        key: Arc<dyn WarmKey>,
        port: Arc<dyn WarmPort>,
        ledger: Arc<dyn WarmLedger>,
    ) -> Arc<Self> {
        Self::with_deps(WarmDeps {
            config,
            key,
            port,
            ledger,
            magnet: Arc::new(NoMagnet),
            queue: Arc::new(RamQueue),
            traffic: None,
        })
    }

    pub(crate) fn with_deps(deps: WarmDeps) -> Arc<Self> {
        let warmer = Arc::new(Self {
            inner: Arc::new(Inner {
                config: deps.config,
                key: deps.key,
                port: deps.port,
                ledger: deps.ledger,
                magnet: deps.magnet,
                queue: deps.queue,
                traffic: deps.traffic,
                state: Mutex::new(State::default()),
                paused: AtomicBool::new(false),
                last_tick_at: AtomicI64::new(0),
                ticker_started: AtomicBool::new(false),
            }),
        });
        warmer.hydrate();
        warmer
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn pending(&self) -> usize {
        self.lock().queue.len()
    }

    #[allow(dead_code)]
    pub(crate) fn counters(&self) -> Counters {
        self.lock().counters
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        self.inner.paused.store(paused, Ordering::SeqCst);
    }

    pub(crate) fn is_paused(&self) -> bool {
        self.inner.paused.load(Ordering::SeqCst)
    }

    /// A régua do `enqueue` do Node: score, dedupe, corte, ledger, teto.
    /// Devolve quantos hashes entraram (já descontados os descartes).
    pub(crate) fn enqueue(&self, payload: &Value, scope: &str) -> usize {
        if !is_rd_scope(scope) {
            return 0;
        }
        let Some(releases) = payload.get("releases").and_then(Value::as_array) else {
            return 0;
        };
        let mut picks: Vec<(String, i64)> = Vec::new();
        for release in releases {
            let Some(raw) = release.get("infoHash").and_then(Value::as_str) else {
                continue;
            };
            let hash = adom_core::normalize_hash(raw);
            if hash.is_empty() {
                continue;
            }
            let br = release
                .get("isBr")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let dubbed = release
                .get("dubbed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let score = match (br, dubbed) {
                (true, true) => SCORE_BR_DUBBED,
                (_, true) => SCORE_DUBBED,
                _ => SCORE_OTHER,
            };
            match picks.iter_mut().find(|(known, _)| *known == hash) {
                Some((_, best)) => {
                    if score > *best {
                        *best = score;
                    }
                }
                None => picks.push((hash, score)),
            }
        }
        // `sort_by` é estável: empate mantém a ordem de chegada do efeito.
        picks.sort_by_key(|item| std::cmp::Reverse(item.1));
        picks.truncate(PER_EFFECT_MAX);
        let now = adom_sources::now_ms();
        let mut added = 0;
        let mut state = self.lock();
        for (hash, score) in picks {
            // Entrada herdada do Node (sem conta) é ADOTADA pelo escopo atual
            // em vez de duplicar o hash. Duas contas explícitas continuam
            // podendo ter o mesmo hash cada uma com sua linha.
            let existing = state.queue.iter().position(|known| {
                known.hash == hash
                    && (known.scope.as_str() == scope || known.scope.is_empty() || scope.is_empty())
            });
            if let Some(index) = existing {
                if state.queue[index].scope.is_empty() && !scope.is_empty() {
                    state.queue[index].scope = scope.to_string();
                }
                // O Node guarda o MAIOR score do hash entre efeitos; sem isso
                // um item que chegou como "resto" nunca sobe para BR+dublado.
                if score > state.queue[index].score {
                    state.queue[index].score = score;
                }
                continue;
            }
            // O ledger é a fonte da verdade: hit/blocked não gastam sonda.
            if !matches!(self.inner.ledger.state(&hash, now), LedgerMark::Other) {
                state.counters.skipped += 1;
                continue;
            }
            if state.queue.len() >= self.inner.config.queue_max {
                state.counters.dropped_full += 1;
                continue;
            }
            state.queue.push_back(WarmItem {
                hash,
                scope: scope.to_string(),
                score,
                enqueued_at: now,
            });
            state.counters.enqueued += 1;
            added += 1;
        }
        // A fila do Node é global e ordenada por score/chegada; a nossa é
        // por escopo, mas a ORDEM dentro de cada escopo segue a mesma régua.
        state.queue.make_contiguous().sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(a.enqueued_at.cmp(&b.enqueued_at))
        });
        drop(state);
        // O Node persiste em todo `enqueue` (inclusive score renovado); o custo
        // é uma escrita JSON por efeito, não por hash.
        self.persist_queue();
        added
    }

    /// Enfileira e agenda a drenagem (nunca espera HTTP). A drenagem só roda
    /// fora da janela de tráfego — quem publica não bloqueia o usuário.
    pub(crate) fn publish(&self, payload: &Value, scope: &str) -> usize {
        let added = self.enqueue(payload, scope);
        if added > 0 {
            self.schedule();
        }
        added
    }

    /// Reparo idempotente dos `bad` que o ramo antigo do warmer gravou: hash
    /// que o RD recusou por lei (451) não é magnet quebrado. Roda no boot.
    pub(crate) fn scan_blocked_bads(&self) -> usize {
        let now = adom_sources::now_ms();
        let cleared = self
            .inner
            .magnet
            .scan_blocked_bads(self.inner.ledger.as_ref(), now);
        if cleared > 0 {
            eprintln!("[warmer] {cleared} bad(s) de recusa legal recuperado(s)");
        }
        cleared
    }
}

#[path = "rd_warmer_drain.rs"]
mod drain;

#[path = "rd_warmer_admin.rs"]
mod admin;
pub(crate) use admin::router as admin_router;

#[path = "rd_warmer_rd.rs"]
mod rd;
pub(crate) use rd::{register, WarmConfig};

#[cfg(test)]
#[path = "rd_warmer_tests.rs"]
mod tests;
