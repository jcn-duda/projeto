//! Freio de atividade do colhedor: última requisição `/stream` do gateway.
//!
//! O `AtomicI64` é criado em `proxy::run` e escrito em `dispatch` no ramo do
//! `/stream` nativo. `is_busy` é a janela deslizante do TS
//! (`activity.recentUserTraffic`): o colhedor só trabalha quando ninguém usa o
//! addon há `HARVEST_IDLE_WINDOW_MS`.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use adom_harvest::TrafficSense;

/// Última atividade de `/stream` + janela de idle.
#[derive(Clone)]
pub struct StreamTraffic {
    last_stream_ms: Arc<AtomicI64>,
    idle_window_ms: i64,
}

impl StreamTraffic {
    pub fn new(last_stream_ms: Arc<AtomicI64>, idle_window_ms: i64) -> Self {
        Self {
            last_stream_ms,
            idle_window_ms: idle_window_ms.max(0),
        }
    }
}

impl TrafficSense for StreamTraffic {
    fn is_busy(&self) -> bool {
        let last = self.last_stream_ms.load(Ordering::Relaxed);
        // `0` = nunca houve `/stream` neste processo; sem janela não há freio.
        last > 0
            && self.idle_window_ms > 0
            && adom_sources::now_ms().saturating_sub(last) < self.idle_window_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sem_requisicao_nao_esta_ocupado() {
        let traffic = StreamTraffic::new(Arc::new(AtomicI64::new(0)), 600_000);
        assert!(!traffic.is_busy());
    }

    #[test]
    fn dentro_da_janela_esta_ocupado_e_fora_dela_nao() {
        let last = Arc::new(AtomicI64::new(0));
        let traffic = StreamTraffic::new(last.clone(), 60_000);
        // É a escrita que o `dispatch` faz no ramo nativo do `/stream`.
        last.store(adom_sources::now_ms(), Ordering::Relaxed);
        assert!(traffic.is_busy());
        last.store(adom_sources::now_ms() - 120_000, Ordering::Relaxed);
        assert!(!traffic.is_busy());
    }

    #[test]
    fn janela_zero_desliga_o_freio() {
        let last = Arc::new(AtomicI64::new(adom_sources::now_ms()));
        let traffic = StreamTraffic::new(last, 0);
        assert!(!traffic.is_busy());
    }
}
