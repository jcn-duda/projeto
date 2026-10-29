//! Contadores e retrato do warmer para a API administrativa e o diagnóstico.
//!
//! O retrato NUNCA carrega credencial: `account_source` é só o rótulo
//! (`panel`/`env`/`sessao`/`none`), e os contadores são de processo. A quota é
//! lida da hora civil corrente — um retrato depois da virada zera a leitura
//! sem esperar o próximo tick.

use std::sync::atomic::Ordering;

use super::{Warmer, HOUR_MS};

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

/// Retrato para a API administrativa (nunca carrega credencial).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WarmStatus {
    pub(crate) enabled: bool,
    pub(crate) paused: bool,
    pub(crate) queue_depth: usize,
    pub(crate) queue_max: usize,
    pub(crate) batch: usize,
    pub(crate) max_per_hour: i64,
    pub(crate) queries_this_hour: i64,
    pub(crate) interval_ms: u64,
    pub(crate) idle_window_ms: i64,
    pub(crate) in_flight: bool,
    pub(crate) last_tick_at: Option<i64>,
    pub(crate) account_source: String,
    pub(crate) counters: Counters,
}

impl Warmer {
    pub(crate) fn status(&self) -> WarmStatus {
        let now = adom_sources::now_ms();
        // A origem pode tocar o KV/selo: resolve ANTES de pegar o lock da fila.
        let account_source = self.inner.key.account_source(now).to_string();
        let mut state = self.lock();
        let hour = now.div_euclid(HOUR_MS);
        if state.hour != hour {
            state.hour = hour;
            state.per_hour = 0;
        }
        WarmStatus {
            enabled: true,
            paused: self.is_paused(),
            queue_depth: state.queue.len(),
            queue_max: self.inner.config.queue_max,
            batch: self.inner.config.batch,
            max_per_hour: self.inner.config.max_per_hour,
            queries_this_hour: state.per_hour,
            interval_ms: self.inner.config.interval_ms,
            idle_window_ms: self.inner.config.idle_window_ms,
            in_flight: state.in_flight,
            last_tick_at: match self.inner.last_tick_at.load(Ordering::Relaxed) {
                0 => None,
                at => Some(at),
            },
            account_source,
            counters: state.counters,
        }
    }
}
