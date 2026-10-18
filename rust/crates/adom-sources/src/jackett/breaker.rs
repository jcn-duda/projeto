//! Circuit breaker — porte de `jackett-breaker.ts`.
//!
//! Abre SÓ em offline (falha de rede / fonte morta no envelope). Resultado
//! vazio com HTTP+envelope sadios NÃO conta. Diagnóstico (`test`) fica de fora
//! desta fatia e deve ignorar o breaker no próximo passo.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use super::config::JackettConfig;

/// Estado serializável para o painel (tri-estado + `tripped` booleano).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BreakerSnapshot {
    pub enabled: bool,
    pub tripped: bool,
    /// `"aberto"` | `"fechado"` | `"naomedido"`.
    pub state: &'static str,
    pub fail_streak: u32,
    pub failures_required: u32,
    pub cooldown_ms: u64,
    pub cooldown_remaining_ms: u64,
}

#[derive(Debug, Clone)]
struct IndexerHealth {
    fail_streak: u32,
    /// Epoch ms da última amostra.
    checked_at_ms: i64,
    last_ok: bool,
}

/// Breaker em memória por processo (o TS usa o mesmo processo Node).
#[derive(Debug, Default)]
pub struct Breaker {
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    health: HashMap<String, IndexerHealth>,
    announced: HashMap<String, bool>,
}

impl Breaker {
    pub fn new() -> Self {
        Self::default()
    }

    /// `true` quando o circuito está aberto para este indexer.
    pub fn tripped(&self, indexer: &str, cfg: &JackettConfig, now_ms: i64) -> bool {
        if !cfg.breaker_enabled {
            return false;
        }
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(status) = guard.health.get(indexer) else {
            return false;
        };
        if status.fail_streak < cfg.breaker_failures {
            return false;
        }
        now_ms.saturating_sub(status.checked_at_ms) < cfg.breaker_cooldown_ms as i64
    }

    /// Registra amostra. `ok:false` = offline (rede OU fonte morta). Vazio
    /// saudável deve passar `ok:true`.
    pub fn record(&self, indexer: &str, ok: bool, now_ms: i64) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let entry = guard
            .health
            .entry(indexer.to_string())
            .or_insert(IndexerHealth {
                fail_streak: 0,
                checked_at_ms: now_ms,
                last_ok: true,
            });
        entry.checked_at_ms = now_ms;
        entry.last_ok = ok;
        if ok {
            entry.fail_streak = 0;
            guard.announced.remove(indexer);
        } else {
            entry.fail_streak = entry.fail_streak.saturating_add(1);
        }
    }

    /// Aviso de abertura: no máximo UM por episódio de circuito aberto.
    /// Devolve `true` se este caller deve logar o aviso.
    pub fn should_announce_trip(&self, indexer: &str) -> bool {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.announced.contains_key(indexer) {
            return false;
        }
        guard.announced.insert(indexer.to_string(), true);
        true
    }

    /// Limpa o marcador de anúncio quando o indexer volta a ser consultado.
    pub fn clear_announced(&self, indexer: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.announced.remove(indexer);
    }

    pub fn snapshot(&self, indexer: &str, cfg: &JackettConfig, now_ms: i64) -> BreakerSnapshot {
        let tripped = self.tripped(indexer, cfg, now_ms);
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let status = guard.health.get(indexer);
        let fail_streak = status.map(|s| s.fail_streak).unwrap_or(0);
        let checked_at = status.map(|s| s.checked_at_ms).unwrap_or(0);
        let state = if !cfg.breaker_enabled || status.is_none() {
            "naomedido"
        } else if tripped {
            "aberto"
        } else {
            "fechado"
        };
        let eligible = cfg.breaker_enabled
            && status.is_some()
            && fail_streak >= cfg.breaker_failures
            && checked_at > 0;
        let cooldown_remaining_ms = if eligible {
            cfg.breaker_cooldown_ms
                .saturating_sub(now_ms.saturating_sub(checked_at).max(0) as u64)
        } else {
            0
        };
        BreakerSnapshot {
            enabled: cfg.breaker_enabled,
            tripped,
            state,
            fail_streak,
            failures_required: cfg.breaker_failures,
            cooldown_ms: cfg.breaker_cooldown_ms,
            cooldown_remaining_ms,
        }
    }
}

/// Relógio local (epoch ms) — o mesmo do crate.
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
    fn so_offline_abre_o_circuito() {
        let cfg = JackettConfig {
            breaker_failures: 2,
            breaker_cooldown_ms: 60_000,
            ..JackettConfig::default()
        };
        let b = Breaker::new();
        // Vazio saudável não conta.
        b.record("yts", true, 1_000);
        assert!(!b.tripped("yts", &cfg, 1_100));
        b.record("yts", false, 2_000);
        assert!(!b.tripped("yts", &cfg, 2_100));
        b.record("yts", false, 3_000);
        assert!(b.tripped("yts", &cfg, 3_100));
        // Depois do cooldown reabre.
        assert!(!b.tripped("yts", &cfg, 3_000 + 60_001));
    }
}
