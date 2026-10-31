//! Ledger local (`rdc:v2`) e switches do Real-Debrid.
//!
//! O veredito do RD consulta o ledger do `cache.db` do Node (leitura no
//! `Store` read-only) e o hit renova o TTL pelo KV NATIVO (`NativeKv`) — o
//! MESMO caminho do `blocked` que o play grava; contra o leitor read-only o
//! `put` é recusado de propósito. Nada aqui escreve na conta do serviço.

use std::time::{SystemTime, UNIX_EPOCH};

use adom_core::{ledger_key, next_on_hit, normalize_hash, peek_state};
use adom_index::kv::KvWrite;
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

/// Hit refresca o TTL (`next_on_hit` do núcleo). O estado atual é lido no
/// leitor do `cache.db` (a mesma fonte do veredito) e a ESCRITA vai pelo KV
/// nativo do gateway: contra o leitor read-only o `Store::put` é recusado de
/// propósito ("cache.db do Node é somente leitura") e a renovação era no-op —
/// o caminho é o MESMO do `blocked` que o play grava
/// (`play_effects_native_writes.rs::note_rd_blocked`): `ledger_key`, valor
/// `{s, at, n}` e TTL em segundos. Escrita LOCAL e barata — não passa pelo
/// gate (`DEBRID_RD_GATE` é para escrita NA CONTA; o kill-switch que vale
/// aqui é `DEBRID_RD_LEDGER`, checado acima). Única transação no thread da
/// checagem, que já lê o SQLite neste ponto; falha só loga (fail-open).
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
    // (chave, valor, TTL em segundos) — montado ANTES do KV para a leitura do
    // estado atual não cruzar a escrita.
    let mut renewed: Vec<(String, Value, i64)> = Vec::new();
    for hash in cached {
        let normalized = normalize_hash(hash);
        if normalized.is_empty() {
            continue;
        }
        let current = rd_ledger_state(&normalized, Some(store)).unwrap_or_else(|| "unknown".into());
        let Some(write) = next_on_hit(true, ttl, now_s, &current) else {
            continue;
        };
        renewed.push((
            ledger_key(&normalized),
            json!({ "s": write.s, "at": write.at, "n": write.n }),
            write.ttl_seconds as i64,
        ));
    }
    if renewed.is_empty() {
        return;
    }
    let Some(kv) = crate::native_kv::production_kv() else {
        eprintln!(
            "[debrid] hit rdc:v2 não renovado ({} hash): KV nativo indisponível",
            renewed.len()
        );
        return;
    };
    let writes: Vec<KvWrite<'_>> = renewed
        .iter()
        .map(|(key, value, ttl_seconds)| KvWrite {
            key,
            value,
            ttl_seconds: *ttl_seconds,
            now_ms,
            only_if_absent: false,
        })
        .collect();
    if let Err(err) = kv.put_many_json_and_forget(&writes, &[]) {
        eprintln!("[debrid] renovação de hit rdc:v2 falhou: {err}");
    }
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
