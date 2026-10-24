//! Ledger local (`rdc:v2`) e switches do Real-Debrid.
//!
//! O veredito do RD consulta o ledger do `cache.db` do Node e o hit renova o
//! TTL localmente; nada aqui escreve na conta do serviço.

use std::time::{SystemTime, UNIX_EPOCH};

use adom_core::{ledger_key, next_on_hit, normalize_hash, peek_state};
use serde_json::{json, Value};

use crate::store::Store;

/// TTL de hit do ledger (`DEBRID_RD_LEDGER_HIT_TTL`, em segundos; mesmo
/// default de `src/config/debrid.ts`).
const LEDGER_HIT_TTL_S: f64 = 2_592_000.0;

/// `DEBRID_RD_LEDGER` (default ligado, como em `src/config/debrid.ts`).
pub fn rd_ledger_enabled() -> bool {
    env_flag("DEBRID_RD_LEDGER")
}

/// `DEBRID_RD_ORACLE` — lido e exposto; o oráculo em si é fatia futura. Com o
/// switch ligado a checagem CONTINUA honesta: só o ledger responde, e hash sem
/// entrada sai `Unknown` (nunca `Missing`).
pub fn rd_oracle_enabled() -> bool {
    env_flag("DEBRID_RD_ORACLE")
}

/// `DEBRID_RD_GATE` — o gate AIMD é para escrita na conta; a checagem não
/// escreve na conta. Exposto para diagnóstico e para os testes provarem que o
/// switch não derruba o veredito.
pub fn rd_gate_enabled() -> bool {
    env_flag("DEBRID_RD_GATE")
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|raw| raw.trim() == "true")
        .unwrap_or(true)
}

/// Estado bruto do ledger (`s` do valor gravado), para `peek_state`.
pub(super) fn rd_ledger_state(hash: &str, store: Option<&Store>) -> Option<String> {
    let store = store?;
    let now_ms = now_ms();
    let raw = store.get(&ledger_key(hash), now_ms).ok().flatten()?;
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.get("s").and_then(Value::as_str).map(String::from))
}

/// Leitura do ledger: `Some(true)` hit, `Some(false)` miss medido, `None`
/// desconhecido (ledger off, sem entrada, `blocked` — não condena).
pub(super) fn rd_ledger_known(hash: &str, store: Option<&Store>, ledger_on: bool) -> Option<bool> {
    match peek_state(ledger_on, rd_ledger_state(hash, store).as_deref()) {
        "hit" => Some(true),
        "miss" => Some(false),
        _ => None,
    }
}

/// Hit refresca o TTL (`next_on_hit` do núcleo). Escrita LOCAL e barata — não
/// passa pelo gate porque não toca na conta do RD.
pub(super) fn rd_renew_hits(store: Option<&Store>, cached: &[String]) {
    let Some(store) = store else {
        return;
    };
    if !rd_ledger_enabled() {
        return;
    }
    let ttl = std::env::var("DEBRID_RD_LEDGER_HIT_TTL")
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|ttl| *ttl >= 0.0)
        .unwrap_or(LEDGER_HIT_TTL_S);
    let now_ms = now_ms();
    let now_s = (now_ms as f64) / 1000.0;
    for hash in cached {
        let normalized = normalize_hash(hash);
        if normalized.is_empty() {
            continue;
        }
        let current = rd_ledger_state(&normalized, Some(store)).unwrap_or_else(|| "unknown".into());
        let Some(write) = next_on_hit(true, ttl, now_s, &current) else {
            continue;
        };
        let value = json!({ "s": write.s, "at": write.at, "n": write.n });
        let _ = store.put(
            &ledger_key(&normalized),
            &value.to_string(),
            now_ms + (write.ttl_seconds * 1000.0) as i64,
            now_ms,
        );
    }
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
