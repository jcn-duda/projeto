//! Circuit breaker local do Mico — porte de `mico.ts`.
//!
//! Um único circuito para a fonte. Abre em falhas seguidas (429/5xx/rede/
//! timeout); 4xx ≠ 429 NÃO alimenta (neutro).

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::config::MicoConfig;

#[derive(Debug, Default)]
struct State {
    failures: u32,
    /// Epoch ms em que o limiar foi cruzado (início do cooldown).
    opened_at_ms: i64,
}

/// Breaker em memória por processo (o TS usa singleton do módulo).
#[derive(Debug, Default)]
pub struct Breaker {
    inner: Mutex<State>,
}

impl Breaker {
    pub fn new() -> Self {
        Self::default()
    }

    /// `true` quando o circuito está aberto (cooldown ainda ativo).
    pub fn is_open(&self, cfg: &MicoConfig, now_ms: i64) -> bool {
        if cfg.breaker_failures == 0 {
            return false;
        }
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.failures < cfg.breaker_failures {
            return false;
        }
        now_ms.saturating_sub(guard.opened_at_ms) < cfg.breaker_cooldown_ms as i64
    }

    pub fn note_failure(&self, cfg: &MicoConfig, now_ms: i64) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.failures = guard.failures.saturating_add(1);
        if guard.failures >= cfg.breaker_failures {
            guard.opened_at_ms = now_ms;
            if guard.failures == cfg.breaker_failures {
                eprintln!(
                    "[mico] circuito aberto após {} falha(s) seguidas",
                    guard.failures
                );
            }
        }
    }

    pub fn note_success(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.failures == 0 {
            return;
        }
        guard.failures = 0;
        guard.opened_at_ms = 0;
    }

    /// Zera só o contador (espelha `repairBreaker` do diagnóstico).
    pub fn repair(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.failures = 0;
    }

    /// Reset completo para isolamento de testes (`_resetBreaker`).
    pub fn reset(&self) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = State::default();
    }

    pub fn failures(&self) -> u32 {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .failures
    }
}

pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abre_apos_limiar_e_meia_abre_depois_do_cooldown() {
        let cfg = MicoConfig {
            breaker_failures: 2,
            breaker_cooldown_ms: 60_000,
            ..MicoConfig::default()
        };
        let b = Breaker::new();
        assert!(!b.is_open(&cfg, 1_000));
        b.note_failure(&cfg, 1_000);
        assert!(!b.is_open(&cfg, 1_100));
        b.note_failure(&cfg, 2_000);
        assert!(b.is_open(&cfg, 2_100));
        assert!(!b.is_open(&cfg, 2_000 + 60_001));
        b.note_success();
        assert_eq!(b.failures(), 0);
        assert!(!b.is_open(&cfg, 70_000));
    }
}
