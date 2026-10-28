//! Pontes preparatórias para o estado restante do Chupim v3.
//!
//! Estas APIs operam sobre o mesmo `NativeKv`, mas ainda não transferem os
//! prefixos nem ligam o worker. `ObraStoreV3` e `SuppressedV3` exigem escritor
//! único, requisito que será fornecido pelo worker antes do corte TS.

use std::collections::BTreeMap;

use adom_autofetch::v3::{sha256_hex, ObraStoreV3, SuppressedV3};
use adom_core::{read_record, ObraRecordEntry};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::kv::NativeKv;

fn erro(err: String) -> napi::Error {
    napi::Error::from_reason(err)
}

fn probe_key(kind: &str, imdb_id: &str, season: Option<i64>, episode: Option<i64>) -> String {
    let identity = format!(
        "{kind}:{imdb_id}:{}:{}",
        season.map(|v| v.to_string()).unwrap_or_default(),
        episode.map(|v| v.to_string()).unwrap_or_default()
    );
    format!("autofetch:v3:probe:{}", sha256_hex(&identity))
}

#[napi(catch_unwind)]
pub fn autofetch_v3_probe_key(
    kind: String,
    imdb_id: String,
    season: Option<i64>,
    episode: Option<i64>,
) -> String {
    probe_key(&kind, &imdb_id, season, episode)
}

#[napi(catch_unwind)]
pub fn autofetch_v3_probe_read(
    kv: &NativeKv,
    kind: String,
    imdb_id: String,
    season: Option<i64>,
    episode: Option<i64>,
    now_ms: i64,
) -> napi::Result<Option<String>> {
    let key = probe_key(&kind, &imdb_id, season, episode);
    kv.store()
        .get_json(&key, now_ms)
        .map_err(erro)?
        .map(|v| serde_json::to_string(&v).map_err(|e| erro(e.to_string())))
        .transpose()
}

// O contrato NAPI expõe identidade, registro, TTL e relógio como argumentos
// explícitos; agrupá-los mudaria a assinatura JS gerada sem reduzir o estado.
#[allow(clippy::too_many_arguments)]
#[napi(catch_unwind)]
pub fn autofetch_v3_probe_write(
    kv: &NativeKv,
    kind: String,
    imdb_id: String,
    season: Option<i64>,
    episode: Option<i64>,
    record_json: String,
    ttl_seconds: i64,
    now_ms: i64,
) -> napi::Result<()> {
    if !matches!(kind.as_str(), "movie" | "series")
        || !imdb_id.starts_with("tt")
        || !imdb_id[2..].bytes().all(|b| b.is_ascii_digit())
    {
        return Err(erro("identidade de sonda inválida".into()));
    }
    let value: Value = serde_json::from_str(&record_json)
        .map_err(|e| erro(format!("registro de sonda inválido: {e}")))?;
    let state = value.get("state").and_then(Value::as_str).unwrap_or("");
    if !matches!(state, "pending" | "found" | "empty" | "failed" | "capped")
        || value.get("at").and_then(Value::as_i64).is_none()
    {
        return Err(erro("estado de sonda inválido".into()));
    }
    let key = probe_key(&kind, &imdb_id, season, episode);
    kv.store()
        .put_json(&key, &value, ttl_seconds.max(1), now_ms)
        .map_err(erro)
}

#[napi(catch_unwind)]
pub fn autofetch_v3_obra_read(
    kv: &NativeKv,
    key: String,
    now_ms: i64,
) -> napi::Result<Option<String>> {
    let Some(value) = kv.store().get_json(&key, now_ms).map_err(erro)? else {
        return Ok(None);
    };
    let entries = read_record(&value);
    serde_json::to_string(&entries_to_json(entries))
        .map(Some)
        .map_err(|e| erro(e.to_string()))
}

fn entries_to_json(entries: Vec<ObraRecordEntry>) -> Vec<Value> {
    entries.into_iter().map(|e| {
        let mut v = json!({"hash":e.hash,"pool":e.pool,"acceptedAt":e.accepted_at,"br":e.br,"dubbed":e.dubbed});
        let obj = v.as_object_mut().expect("literal object");
        if let Some(s) = e.title.filter(|s| !s.is_empty()) { obj.insert("title".into(), json!(s)); }
        if let Some(s) = e.id.filter(|s| !s.is_empty()) { obj.insert("id".into(), json!(s)); }
        if let Some(s) = e.quality.filter(|s| !s.is_empty()) { obj.insert("quality".into(), json!(s)); }
        if e.overflow { obj.insert("overflow".into(), json!(true)); }
        v
    }).collect()
}

#[napi(catch_unwind)]
pub fn autofetch_v3_obra_commit(
    kv: &NativeKv,
    key: String,
    entry_json: String,
    ttl_seconds: i64,
    now_ms: i64,
) -> napi::Result<bool> {
    let value: Value = serde_json::from_str(&entry_json)
        .map_err(|e| erro(format!("entrada de obra inválida: {e}")))?;
    let parsed = read_record(&json!({"entries":[value]}))
        .into_iter()
        .next()
        .unwrap_or_default();
    ObraStoreV3::new(kv.store())
        .commit(&key, &parsed, ttl_seconds, now_ms)
        .map_err(erro)
}

#[napi(catch_unwind)]
pub fn autofetch_v3_obra_forget_hash(
    kv: &NativeKv,
    key: String,
    hash: String,
    ttl_seconds: i64,
    now_ms: i64,
) -> napi::Result<bool> {
    ObraStoreV3::new(kv.store())
        .forget_hash(&key, &hash, ttl_seconds, now_ms)
        .map_err(erro)
}

#[napi(catch_unwind)]
pub fn autofetch_v3_suppressed_key(adapter_id: String, account: String, hash: String) -> String {
    adom_autofetch::v3::suppressed_key(&adapter_id, &account, &hash)
}

#[napi(catch_unwind)]
pub fn autofetch_v3_suppressed_read(
    kv: &NativeKv,
    adapter_id: String,
    account: String,
    hash: String,
    now_ms: i64,
) -> napi::Result<Option<String>> {
    SuppressedV3::new(kv.store())
        .read(&adapter_id, &account, &hash, now_ms)
        .map_err(erro)?
        .map(|v| serde_json::to_string(&v).map_err(|e| erro(e.to_string())))
        .transpose()
}

#[napi(catch_unwind)]
pub fn autofetch_v3_suppressed_note(
    kv: &NativeKv,
    adapter_id: String,
    account: String,
    hash: String,
    id: String,
    ttl_seconds: i64,
    now_ms: i64,
) -> napi::Result<bool> {
    SuppressedV3::new(kv.store())
        .note(&adapter_id, &account, &hash, &id, ttl_seconds, now_ms)
        .map_err(erro)
}

#[napi(catch_unwind)]
pub fn autofetch_v3_suppressed_retry(
    kv: &NativeKv,
    adapter_id: String,
    account: String,
    hash: String,
    ttl_seconds: i64,
    now_ms: i64,
) -> napi::Result<String> {
    let retry = SuppressedV3::new(kv.store())
        .retry(&adapter_id, &account, &hash, ttl_seconds, now_ms)
        .map_err(erro)?;
    Ok(match retry {
        adom_autofetch::v3::SuppressedRetry::Missing => "missing",
        adom_autofetch::v3::SuppressedRetry::Scheduled => "scheduled",
        adom_autofetch::v3::SuppressedRetry::GivenUp => "given-up",
    }
    .into())
}

#[napi(catch_unwind)]
pub fn autofetch_v3_suppressed_forget(
    kv: &NativeKv,
    adapter_id: String,
    account: String,
    hash: String,
) -> napi::Result<bool> {
    SuppressedV3::new(kv.store())
        .forget(&adapter_id, &account, &hash)
        .map_err(erro)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeasonHintV3 {
    pub imdb_id: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub is_pack: Option<bool>,
}

/// Snapshot persistido de lote. RuntimeContext/segredos e timers ficam de fora;
/// eles devem ser reconstruídos pelo processo que retoma o lote.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutofetchLotV3 {
    pub hashes: Vec<String>,
    pub attempts: u32,
    pub dead_streak: BTreeMap<String, u32>,
    pub stall_streak: BTreeMap<String, u32>,
    pub season_hints: BTreeMap<String, SeasonHintV3>,
    pub created_at: i64,
    pub is_settle: bool,
    pub refusals: u32,
    pub adapter_id: String,
}

fn lot_key(search_key: &str) -> String {
    format!("autofetch:v3:lot:{}", sha256_hex(search_key))
}

#[napi(catch_unwind)]
pub fn autofetch_v3_lot_key(search_key: String) -> String {
    lot_key(&search_key)
}

#[napi(catch_unwind)]
pub fn autofetch_v3_lot_read(
    kv: &NativeKv,
    search_key: String,
    now_ms: i64,
) -> napi::Result<Option<String>> {
    kv.store()
        .get_json(&lot_key(&search_key), now_ms)
        .map_err(erro)?
        .map(|value| serde_json::to_string(&value).map_err(|e| erro(e.to_string())))
        .transpose()
}

#[napi(catch_unwind)]
pub fn autofetch_v3_lot_write(
    kv: &NativeKv,
    search_key: String,
    lot_json: String,
    ttl_seconds: i64,
    now_ms: i64,
) -> napi::Result<()> {
    if search_key.is_empty() {
        return Err(erro("searchKey vazio para lote".into()));
    }
    let lot: AutofetchLotV3 = serde_json::from_str(&lot_json)
        .map_err(|e| erro(format!("snapshot de lote inválido: {e}")))?;
    if lot.hashes.iter().any(|h| h.is_empty()) {
        return Err(erro("lote contém hash vazio".into()));
    }
    let value = serde_json::to_value(lot).map_err(|e| erro(e.to_string()))?;
    kv.store()
        .put_json(&lot_key(&search_key), &value, ttl_seconds.max(1), now_ms)
        .map_err(erro)
}

#[napi(catch_unwind)]
pub fn autofetch_v3_lot_forget(kv: &NativeKv, search_key: String) -> napi::Result<bool> {
    kv.store().forget(&lot_key(&search_key)).map_err(erro)
}

#[napi(catch_unwind)]
pub fn autofetch_v3_lot_keys(kv: &NativeKv, now_ms: i64) -> napi::Result<Vec<String>> {
    kv.store()
        .keys_matching("autofetch:v3:lot:", now_ms)
        .map_err(erro)
}

#[cfg(test)]
#[path = "state_v3_tests.rs"]
mod tests;
