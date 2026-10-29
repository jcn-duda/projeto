//! Ledger `rdc:v2` do warmer: a MESMA chave e a MESMA forma `{s,at,n}` do
//! veredito nativo.
//!
//! `hit`/`blocked` são lidos no `enqueue` para não gastar sonda; `miss` só
//! grava depois do backoff, nunca no primeiro erro. A unidade de `at` é
//! SEGUNDOS (como o Node) e `n` é o contador de tentativas.

use std::sync::Arc;

use adom_core::{
    ledger_key, next_on_blocked, next_on_hit, next_on_miss, normalize_hash, peek_state,
};
use adom_index::NativeKv;
use serde_json::{json, Value};

use super::env_flag;
use crate::rd_warmer::{LedgerMark, WarmLedger, WarmSignal};

pub(super) struct KvLedger {
    pub(super) kv: Option<Arc<NativeKv>>,
    enabled: bool,
    hit_ttl_s: f64,
    blocked_ttl_s: f64,
    backoff_ms: Vec<f64>,
}

impl KvLedger {
    pub(super) fn from_env() -> Self {
        let kv = NativeKv::open(&adom_store::default_cache_db_path())
            .map(Arc::new)
            .map_err(|err| eprintln!("[warmer] ledger rdc:v2 indisponível ({err}); sem hits"))
            .ok();
        Self {
            kv,
            enabled: env_flag("DEBRID_RD_LEDGER"),
            hit_ttl_s: env_num_f("DEBRID_RD_LEDGER_HIT_TTL", 2_592_000.0),
            blocked_ttl_s: env_num_f("DEBRID_RD_LEDGER_BLOCKED_TTL", 2_592_000.0),
            backoff_ms: env_list(
                "DEBRID_RD_LEDGER_MISS_BACKOFF_MS",
                &[1_800_000.0, 7_200_000.0, 43_200_000.0, 259_200_000.0],
            ),
        }
    }

    #[cfg(test)]
    pub(super) fn memory() -> Self {
        Self {
            kv: Some(Arc::new(NativeKv::open_memory().expect("kv em memória"))),
            enabled: true,
            hit_ttl_s: 2_592_000.0,
            blocked_ttl_s: 2_592_000.0,
            backoff_ms: vec![1_800_000.0, 7_200_000.0],
        }
    }

    fn stored_state(&self, kv: &NativeKv, hash: &str, now_ms: i64) -> String {
        let value = kv.get_json(&ledger_key(hash), now_ms).ok().flatten();
        let state = value
            .as_ref()
            .and_then(|value| value.get("s"))
            .and_then(Value::as_str);
        peek_state(true, state).to_string()
    }

    fn prior(&self, kv: &NativeKv, hash: &str, now_ms: i64) -> (Option<String>, Option<f64>) {
        let Some(value) = kv.get_json(&ledger_key(hash), now_ms).ok().flatten() else {
            return (None, None);
        };
        (
            value.get("s").and_then(Value::as_str).map(str::to_string),
            value.get("n").and_then(Value::as_f64),
        )
    }
}

impl WarmLedger for KvLedger {
    fn state(&self, hash: &str, now_ms: i64) -> LedgerMark {
        let Some(kv) = self.kv.as_deref().filter(|_| self.enabled) else {
            return LedgerMark::Other;
        };
        if normalize_hash(hash).is_empty() {
            return LedgerMark::Other;
        }
        match self.stored_state(kv, hash, now_ms).as_str() {
            "hit" => LedgerMark::Hit,
            "blocked" => LedgerMark::Blocked,
            _ => LedgerMark::Other,
        }
    }

    fn note(&self, hash: &str, signal: WarmSignal, now_ms: i64) {
        let Some(kv) = self.kv.as_deref().filter(|_| self.enabled) else {
            return;
        };
        // Mesma unidade do `verdict_ledger` nativo (`at` em segundos).
        let now = now_ms as f64 / 1000.0;
        let current = self.stored_state(kv, hash, now_ms);
        let write = match signal {
            WarmSignal::Hit => next_on_hit(true, self.hit_ttl_s, now, &current),
            WarmSignal::Blocked => next_on_blocked(true, hash, self.blocked_ttl_s, now),
            WarmSignal::Miss => {
                let (prior_s, prior_n) = self.prior(kv, hash, now_ms);
                next_on_miss(
                    true,
                    hash,
                    &self.backoff_ms,
                    now,
                    &current,
                    prior_s.as_deref(),
                    prior_n,
                )
            }
        };
        let Some(write) = write else {
            return;
        };
        let target = write.hash.clone().unwrap_or_else(|| normalize_hash(hash));
        if target.is_empty() {
            return;
        }
        let value = json!({ "s": write.s, "at": num(write.at), "n": num(write.n) });
        let ttl_seconds = write.ttl_seconds.ceil() as i64;
        if let Err(err) = kv.put_json(&ledger_key(&target), &value, ttl_seconds, now_ms) {
            eprintln!("[warmer] ledger rdc:v2 não gravou: {err}");
        }
    }
}

/// Número na forma do Node: inteiro vira `0`/`1`, não `0.0`/`1.0`.
fn num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= i64::MAX as f64 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn env_num_f(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|value| *value >= 0.0)
        .unwrap_or(default)
}

fn env_list(key: &str, default: &[f64]) -> Vec<f64> {
    let parsed: Vec<f64> = std::env::var(key)
        .map(|raw| {
            raw.split(',')
                .filter_map(|item| item.trim().parse::<f64>().ok())
                .filter(|value| *value >= 0.0)
                .collect()
        })
        .unwrap_or_default();
    if parsed.is_empty() {
        default.to_vec()
    } else {
        parsed
    }
}
