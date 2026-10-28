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
//!    hora civil (`DEBRID_RD_WARM_MAX_HOUR`), e registra `noteHit`/`noteMiss`/
//!    `noteBlocked` no ledger — a ÚNICA fonte do ⚡ do RD no veredito nativo;
//! 4. rate limit/quota NÃO ganham backoff paralelo: cooldown e quarentena são
//!    do `RdGateExecutor` (`adom-debrid`) e o lote para no primeiro sinal.
//!
//! # O que NÃO foi portado (divergências assumidas)
//!
//! - fila persistente (`rdq:v1:wq`) e balde horário em KV: esta fatia pede fila
//!   em RAM; restart zera a fila, o balde e o contador;
//! - janela ociosa (`idleWindowMs`): sem o timer do Node, o lote só roda quando
//!   chega efeito — e chegar efeito já é tráfego de usuário;
//! - `magnetdb.markAlive` e o `scanBlockedRdBads` do boot: o `mag:v1` é escrito
//!   pelo Node nesta fatia.
//!
//! A drenagem é fire-and-forget: [`Warmer::offer`] só empurra para a fila em RAM
//! e devolve; quem publica nunca espera HTTP.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::Value;

use crate::tail_effects::NativeEffectSink;

pub(crate) use rd::{register, WarmConfig};

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

/// Chave da conta, lida do cofre (`autofetch::shared_vault` + `Vault::key`) no
/// momento do uso. NUNCA vem do payload do efeito.
pub(crate) trait WarmKey: Send + Sync {
    fn rd_key(&self, now_ms: i64) -> Option<String>;
}

/// Ledger `rdc:v2` (leitura para pular, escrita para o ⚡).
pub(crate) trait WarmLedger: Send + Sync {
    fn state(&self, hash: &str, now_ms: i64) -> LedgerMark;
    fn note(&self, hash: &str, signal: WarmSignal, now_ms: i64);
}

/// Contadores do processo (o painel lê; o teste prova).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Counters {
    pub(crate) enqueued: u64,
    pub(crate) skipped: u64,
    pub(crate) dropped_full: u64,
    pub(crate) dropped_no_key: u64,
    pub(crate) probes: u64,
    pub(crate) hits: u64,
    pub(crate) misses: u64,
    pub(crate) blocked: u64,
    pub(crate) stopped: u64,
}

#[derive(Default)]
struct State {
    queue: VecDeque<String>,
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
    state: Mutex<State>,
}

/// Fila em RAM + dedupe + teto. Barato de publicar, caro só na drenagem.
pub(crate) struct Warmer {
    inner: Arc<Inner>,
}

impl Warmer {
    pub(crate) fn new(
        config: WarmConfig,
        key: Arc<dyn WarmKey>,
        port: Arc<dyn WarmPort>,
        ledger: Arc<dyn WarmLedger>,
    ) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(Inner {
                config,
                key,
                port,
                ledger,
                state: Mutex::new(State::default()),
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Hashes na fila (o teste e o painel leem).
    #[allow(dead_code)]
    pub(crate) fn pending(&self) -> usize {
        self.lock().queue.len()
    }

    #[allow(dead_code)]
    pub(crate) fn counters(&self) -> Counters {
        self.lock().counters
    }

    /// A régua do `enqueue` do Node: score, dedupe, corte, ledger, teto.
    /// Devolve quantos hashes entraram (já descontados os descartes).
    pub(crate) fn enqueue(&self, payload: &Value) -> usize {
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
        picks.sort_by(|left, right| right.1.cmp(&left.1));
        picks.truncate(PER_EFFECT_MAX);
        let now = adom_sources::now_ms();
        let mut added = 0;
        let mut state = self.lock();
        for (hash, _) in picks {
            if state.queue.iter().any(|known| *known == hash) {
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
            state.queue.push_back(hash);
            state.counters.enqueued += 1;
            added += 1;
        }
        added
    }

    /// Enfileira e agenda a drenagem (nunca espera HTTP).
    pub(crate) fn publish(&self, payload: &Value) -> usize {
        let added = self.enqueue(payload);
        if added > 0 {
            self.schedule();
        }
        added
    }

    fn schedule(&self) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let warmer = Self {
            inner: self.inner.clone(),
        };
        tokio::spawn(async move {
            warmer.drain().await;
        });
    }

    /// Drena a fila em lotes. Um drain por vez (`in_flight`), como o `DubAudit`.
    /// Devolve quantos hashes foram sondados.
    pub(crate) async fn drain(&self) -> usize {
        {
            let mut state = self.lock();
            if state.in_flight || state.queue.is_empty() {
                return 0;
            }
            state.in_flight = true;
        }
        let _flight = FlightGuard {
            inner: self.inner.clone(),
        };
        let mut warmed = 0;
        loop {
            let now = adom_sources::now_ms();
            let batch = self.take_batch(now);
            if batch.is_empty() {
                break;
            }
            let Some(api_key) = self.inner.key.rd_key(now) else {
                // Sem credencial não há sonda: descarta o lote com contador.
                let mut state = self.lock();
                state.counters.dropped_no_key += batch.len() as u64;
                drop(state);
                eprintln!(
                    "[warmer] sem chave no cofre; {} hash(es) descartado(s)",
                    batch.len()
                );
                break;
            };
            let report = self.inner.port.warm(&api_key, &batch).await;
            self.apply(&report, now);
            warmed += batch.len();
            if report.stopped {
                // O que o gate não sondou volta para a frente: trabalho não se
                // perde por cooldown.
                let mut batch = batch;
                let back = batch.split_off(report.attempted.min(batch.len()));
                self.push_front(back);
                break;
            }
        }
        warmed
    }

    /// Tira até `batch` hashes respeitando o teto da hora civil.
    fn take_batch(&self, now: i64) -> Vec<String> {
        let mut state = self.lock();
        let hour = now.div_euclid(HOUR_MS);
        if state.hour != hour {
            state.hour = hour;
            state.per_hour = 0;
        }
        let room = (self.inner.config.max_per_hour - state.per_hour).max(0) as usize;
        if room == 0 {
            if !state.queue.is_empty() {
                state.counters.stopped += 1;
                eprintln!(
                    "[warmer] teto de {} sonda(s)/hora atingido; fila parada",
                    self.inner.config.max_per_hour
                );
            }
            return Vec::new();
        }
        let take = self.inner.config.batch.min(room).min(state.queue.len());
        let batch: Vec<String> = state.queue.drain(..take).collect();
        state.per_hour += batch.len() as i64;
        state.counters.probes += batch.len() as u64;
        batch
    }

    fn push_front(&self, back: Vec<String>) {
        if back.is_empty() {
            return;
        }
        let mut state = self.lock();
        for hash in back.into_iter().rev() {
            state.queue.push_front(hash);
        }
    }

    fn apply(&self, report: &WarmReport, now: i64) {
        {
            let mut state = self.lock();
            for (_, signal) in &report.signals {
                match signal {
                    WarmSignal::Hit => state.counters.hits += 1,
                    WarmSignal::Miss => state.counters.misses += 1,
                    WarmSignal::Blocked => state.counters.blocked += 1,
                }
            }
            if report.stopped {
                state.counters.stopped += 1;
            }
        }
        for (hash, signal) in &report.signals {
            self.inner.ledger.note(hash, *signal, now);
        }
    }
}

impl NativeEffectSink for Warmer {
    fn offer(&self, kind: &str, payload: &Value) {
        if kind == RD_WARMER {
            self.publish(payload);
        }
    }
}

/// Solta o `in_flight` mesmo em panic ou cancelamento da tarefa.
struct FlightGuard {
    inner: Arc<Inner>,
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        state.in_flight = false;
    }
}

#[path = "rd_warmer_rd.rs"]
mod rd;

#[cfg(test)]
#[path = "rd_warmer_tests.rs"]
mod tests;
