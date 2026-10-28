//! Leitura dos gates vivos usados ao enfileirar (espelho de `autofetch-live` e
//! `autofetch-gates.ts`). O orçamento fica no prefixo já reservado ao worker.

use adom_autofetch::v3::sha256_hex;
use adom_index::NativeKv;
use serde_json::{json, Value};

const LIVE_CONFIG_KEY: &str = "cfg:v1:autofetch";
const BUDGET_PREFIX: &str = "autofetch-worker:v1:budget:";
const HOUR_MS: i64 = 60 * 60 * 1000;

#[derive(Clone, Copy, Debug)]
pub(in crate::autofetch) struct LivePolicy {
    pub(in crate::autofetch) max_attempts: i64,
    pub(in crate::autofetch) top_seeds_max: i64,
    pub(in crate::autofetch) top_seeds_enabled: bool,
    pub(in crate::autofetch) any_dubbed_enabled: bool,
    pub(in crate::autofetch) queue_enabled: bool,
    pub(in crate::autofetch) queue_depth: usize,
    pub(in crate::autofetch) hourly_limit: usize,
    pub(in crate::autofetch) pause_at: u64,
}

impl LivePolicy {
    pub(in crate::autofetch) fn load(
        kv: &NativeKv,
        adapter: &str,
        now_ms: i64,
    ) -> Result<Self, String> {
        let live = kv.get_json(LIVE_CONFIG_KEY, now_ms)?;
        let number = |key: &str, env: &str, fallback: i64| {
            live.as_ref()
                .and_then(|value| value.get(key))
                .and_then(Value::as_i64)
                .or_else(|| std::env::var(env).ok()?.trim().parse::<i64>().ok())
                .unwrap_or(fallback)
        };
        let boolean = |key: &str, env: &str, fallback: bool| {
            live.as_ref()
                .and_then(|value| value.get(key))
                .and_then(Value::as_bool)
                .or_else(|| std::env::var(env).ok().map(|value| value == "true"))
                .unwrap_or(fallback)
        };
        let max_attempts = number("autoFetchMax", "DEBRID_AUTO_FETCH_MAX", 3).clamp(1, 12);
        let top_seeds_max =
            number("autoFetchTopSeedsMax", "DEBRID_AUTO_FETCH_TOP_SEEDS_MAX", 2).clamp(1, 4);
        let queue_depth = if boolean("autoFetchQueue", "DEBRID_AUTO_FETCH_QUEUE", true) {
            number("autoFetchQueueDepth", "DEBRID_AUTO_FETCH_QUEUE_DEPTH", 6).clamp(0, 12) as usize
        } else {
            0
        };
        // TorBox tem limite próprio no adaptador TS; os outros usam a régua
        // global, que também pode receber override do painel.
        let default_hourly = 50;
        let configured_hourly = number(
            "autoFetchEnqueueMaxHour",
            "DEBRID_AUTO_FETCH_ENQUEUE_MAX_HOUR",
            default_hourly,
        )
        .max(1) as usize;
        let hourly_limit = if adapter == "torbox" {
            50
        } else {
            configured_hourly
        };
        let pause_at =
            number("autoFetchPauseAt", "DEBRID_AUTO_FETCH_PAUSE_AT", 2_000).max(0) as u64;
        Ok(Self {
            max_attempts,
            top_seeds_max,
            top_seeds_enabled: boolean("autoFetchTopSeeds", "DEBRID_AUTO_FETCH_TOP_SEEDS", true),
            any_dubbed_enabled: boolean("autoFetchAnyDubbed", "DEBRID_AUTO_FETCH_ANY_DUBBED", true),
            queue_enabled: queue_depth > 0,
            queue_depth,
            hourly_limit,
            pause_at,
        })
    }
}

pub(in crate::autofetch) fn account_is_blocked(used: Option<u64>, pause_at: u64) -> bool {
    pause_at > 0 && used.is_some_and(|count| count >= pause_at)
}

fn budget_key(adapter: &str, account: &str) -> String {
    // O escopo já é digestado; hash novamente evita que delimitadores ou
    // conteúdo externo alterem o prefixo administrativo.
    format!(
        "{BUDGET_PREFIX}{}",
        sha256_hex(&format!("{adapter}:{account}"))
    )
}

fn read_timestamps(kv: &NativeKv, key: &str, now_ms: i64) -> Result<Vec<i64>, String> {
    let Some(value) = kv.get_json(key, now_ms)? else {
        return Ok(Vec::new());
    };
    let Some(values) = value.as_array() else {
        return Ok(Vec::new());
    };
    Ok(values
        .iter()
        .filter_map(Value::as_i64)
        .filter(|at| *at > now_ms.saturating_sub(HOUR_MS))
        .collect())
}

pub(in crate::autofetch) fn budget_count(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    now_ms: i64,
) -> Result<usize, String> {
    read_timestamps(kv, &budget_key(adapter, account), now_ms).map(|items| items.len())
}

/// Reserva uma chamada antes do HTTP, como `checkAndRecordBudget` no TS. A
/// falha/recusa do serviço consome cota; orçamento esgotado não consome nada.
pub(in crate::autofetch) fn reserve_budget(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    limit: usize,
    now_ms: i64,
) -> Result<bool, String> {
    let key = budget_key(adapter, account);
    let mut timestamps = read_timestamps(kv, &key, now_ms)?;
    if timestamps.len() >= limit {
        return Ok(false);
    }
    timestamps.push(now_ms);
    kv.put_json(&key, &json!(timestamps), 3_600, now_ms)?;
    Ok(true)
}

#[cfg(test)]
#[path = "enqueue_gates_tests.rs"]
mod tests;
