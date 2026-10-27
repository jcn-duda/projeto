//! Ponte napi do FORMATO v3 da fila do Chupim (`adom-autofetch::v3`).
//!
//! A fila por busca (`autofetch:v3:q:<sha256(searchKey)>`) é o que o Node grava
//! e drena hoje (`autofetch.ts`/`autofetch-drain.ts`); o `QueueCandidate` é o
//! contrato do dreno. Estas portas NÃO são o wiring da T3-L5 — o caminho de
//! produção continua no cache do Node; elas existem para a prova de round-trip
//! (`test/autofetch-queue-bridge.test.ts`) e para o worker nativo consumir o
//! formato real quando a leva fiar enqueue+dreno.
//!
//! Convenção de JSON: o candidato cruza como STRING (o `JSON.stringify` do
//! Node), nunca como objeto napi — é o que preserva o formato exato que o
//! `cache.set` grava na tabela `cache`.

use adom_autofetch::v3 as core;
use napi_derive::napi;

use crate::kv::NativeKv;

fn erro(err: String) -> napi::Error {
    napi::Error::from_reason(err)
}

/// Chave da fila da busca — tem que bater com o `queueKey` do Node
/// (`autofetch:v3:q:<sha256 hex minúsculo>`).
#[napi(catch_unwind)]
pub fn autofetch_v3_queue_key(search_key: String) -> String {
    core::queue_key(&search_key)
}

/// Lê a fila da busca (JSON de `QueueCandidate[]`; `null` = sem fila).
#[napi(catch_unwind)]
pub fn autofetch_v3_read_queue(
    kv: &NativeKv,
    search_key: String,
    now_ms: i64,
) -> napi::Result<Option<String>> {
    let candidates = kv
        .v3_queue()
        .read_queue(&search_key, now_ms)
        .map_err(erro)?;
    if candidates.is_empty() {
        return Ok(None);
    }
    serde_json::to_string(&candidates)
        .map(Some)
        .map_err(|err| erro(err.to_string()))
}

/// Relatório do `write_queue` (`kept`/`dropped`).
#[napi(object)]
pub struct AutofetchQueueWriteReport {
    /// Candidatos gravados (o `clean.length` do `writeQueue` do Node).
    pub kept: f64,
    /// Descartados: sem hash, duplicado, morto, acima da profundidade.
    pub dropped: f64,
}

/// Opções do `write_queue`: TTL, profundidade e o escopo (adapter:conta) do
/// filtro de hash morto — só filtra com OS DOIS, como o `writeQueue` do Node.
#[napi(object)]
pub struct AutofetchQueueWriteOpts {
    /// TTL da chave da fila (`DEBRID_AUTO_FETCH_QUEUE_TTL`, default 86400).
    pub ttl_seconds: f64,
    /// Teto de candidatos na fila (`autoFetchQueueDepth`).
    pub depth: f64,
    /// Adapter do filtro de mortos (opcional; filtro inativo sem a conta).
    pub adapter_id: Option<String>,
    /// Conta do filtro de mortos (opcional; filtro inativo sem o adapter).
    pub account: Option<String>,
}

/// Grava a fila com as regras do `writeQueue` do Node e devolve o relatório.
#[napi(catch_unwind)]
pub fn autofetch_v3_write_queue(
    kv: &NativeKv,
    search_key: String,
    candidates_json: String,
    opts: AutofetchQueueWriteOpts,
    now_ms: i64,
) -> napi::Result<AutofetchQueueWriteReport> {
    let candidates: Vec<core::QueueCandidate> = serde_json::from_str(&candidates_json)
        .map_err(|err| erro(format!("JSON da fila inválido: {err}")))?;
    let depth = (opts.depth as i64).clamp(1, i64::from(i32::MAX)) as usize;
    let scope = opts.adapter_id.as_deref().zip(opts.account.as_deref());
    let report = kv
        .v3_queue()
        .write_queue(
            &search_key,
            &candidates,
            opts.ttl_seconds as i64,
            depth,
            scope,
            now_ms,
        )
        .map_err(erro)?;
    Ok(AutofetchQueueWriteReport {
        kept: f64::from(i32::try_from(report.kept).unwrap_or(i32::MAX)),
        dropped: f64::from(i32::try_from(report.dropped).unwrap_or(i32::MAX)),
    })
}

/// Apaga a fila (aceita chave pronta ou searchKey); `false` = não havia nada.
#[napi(catch_unwind)]
pub fn autofetch_v3_drop_queue(kv: &NativeKv, key_or_search_key: String) -> napi::Result<bool> {
    kv.v3_queue().drop_queue(&key_or_search_key).map_err(erro)
}

/// Chaves de fila vivas (varredura de reindex/status).
#[napi(catch_unwind)]
pub fn autofetch_v3_queue_keys(kv: &NativeKv, now_ms: i64) -> napi::Result<Vec<String>> {
    kv.v3_queue().queue_keys(now_ms).map_err(erro)
}

/// Marca o hash como morto na conta (`autofetch:v3:dead:…` = 1).
#[napi(catch_unwind)]
pub fn autofetch_v3_mark_dead(
    kv: &NativeKv,
    adapter_id: String,
    account: String,
    info_hash: String,
    ttl_seconds: i64,
    now_ms: i64,
) -> napi::Result<()> {
    kv.v3_queue()
        .mark_dead(&adapter_id, &account, &info_hash, ttl_seconds, now_ms)
        .map_err(erro)
}

/// O hash está na blacklist da conta.
#[napi(catch_unwind)]
pub fn autofetch_v3_is_dead(
    kv: &NativeKv,
    adapter_id: String,
    account: String,
    info_hash: String,
    now_ms: i64,
) -> napi::Result<bool> {
    kv.v3_queue()
        .is_dead(&adapter_id, &account, &info_hash, now_ms)
        .map_err(erro)
}

/// Grava o marker na forma crua recebida (`1`, `{id}`, `{id,…meta}`).
#[napi(catch_unwind)]
pub fn autofetch_v3_set_marker(
    kv: &NativeKv,
    adapter_id: String,
    account: String,
    info_hash: String,
    value_json: String,
    ttl_seconds: i64,
    now_ms: i64,
) -> napi::Result<()> {
    let value: serde_json::Value = serde_json::from_str(&value_json)
        .map_err(|err| erro(format!("JSON do marker inválido: {err}")))?;
    kv.v3_queue()
        .set_marker(
            &adapter_id,
            &account,
            &info_hash,
            &value,
            ttl_seconds,
            now_ms,
        )
        .map_err(erro)
}

/// Marker cru (JSON ou `null` = sem aceite registrado).
#[napi(catch_unwind)]
pub fn autofetch_v3_marker(
    kv: &NativeKv,
    adapter_id: String,
    account: String,
    info_hash: String,
    now_ms: i64,
) -> napi::Result<Option<String>> {
    let value = kv
        .v3_queue()
        .marker(&adapter_id, &account, &info_hash, now_ms)
        .map_err(erro)?;
    match value {
        None => Ok(None),
        Some(value) => serde_json::to_string(&value)
            .map(Some)
            .map_err(|err| erro(err.to_string())),
    }
}

/// Apaga o marker (o evict/desbloqueio do recheck fazem isso no Node).
#[napi(catch_unwind)]
pub fn autofetch_v3_forget_marker(
    kv: &NativeKv,
    adapter_id: String,
    account: String,
    info_hash: String,
) -> napi::Result<bool> {
    kv.v3_queue()
        .forget_marker(&adapter_id, &account, &info_hash)
        .map_err(erro)
}
