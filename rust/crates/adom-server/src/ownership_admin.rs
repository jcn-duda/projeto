//! Escritas duráveis de posse e proteção do AllDebrid.
//!
//! As rotas são montadas apenas na API administrativa loopback autenticada.
//! Nenhuma rota pública pode gravar `adsub`, `adrm`, `adprot` ou `adhold`.
//! `accept` exige a prova completa de que o hash não existia antes do upload e
//! confirma posse/proteção antes de soltar o hold na mesma transação SQLite.

use adom_index::{kv::KvWrite, NativeKv};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};

const HOLD_TTL_MAX: i64 = 7 * 24 * 60 * 60;
const OWNERSHIP_TTL_MAX: i64 = 10 * 365 * 24 * 60 * 60;
const REUPLOAD_TTL_MAX: i64 = 30 * 24 * 60 * 60;

// `ready` precisa manter o lock desde a leitura do adprot até a atualização.
// Compartilha a mesma serialização com remoção e unprotect, evitando que uma
// resposta de ready atrasada recrie a proteção após esses caminhos terminarem.
static OWNERSHIP_MUTATION_LOCK: Mutex<()> = Mutex::new(());

fn mutation_lock() -> MutexGuard<'static, ()> {
    OWNERSHIP_MUTATION_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Abre o mesmo `cache.db` compartilhado com o Node. Falha de abertura não
/// interrompe o gateway; todas as operações de escrita retornam 503.
pub fn from_env() -> Option<std::sync::Arc<NativeKv>> {
    match NativeKv::open(&adom_store::default_cache_db_path()) {
        Ok(kv) => Some(std::sync::Arc::new(kv)),
        Err(err) => {
            eprintln!("[gateway] ownership KV indisponível: {err}");
            None
        }
    }
}

pub fn router() -> Router<std::sync::Arc<super::store_admin::AdminState>> {
    Router::new()
        .route("/ownership/hold", post(hold))
        .route("/ownership/release", post(release))
        .route("/ownership/accept", post(accept))
        .route("/ownership/ready", post(ready))
        .route("/ownership/unprotect", post(unprotect))
        .route("/ownership/reupload-unblock", post(reupload_unblock))
        .route("/ownership/deleted", post(deleted))
}

async fn hold(
    State(state): State<std::sync::Arc<super::store_admin::AdminState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(kv) = ready_store(&state) else {
        return unavailable();
    };
    let (Some(account), Some(hash), Some(ttl)) = (
        account(&body),
        hash(&body),
        ttl(&body, "ttlSeconds", HOLD_TTL_MAX),
    ) else {
        return bad_request("hold exige accountScope, infoHash e ttlSeconds válido");
    };
    let key = hold_key(account, hash);
    write(kv.put_json(&key, &json!({ "at": now_ms() }), ttl, now_ms()))
}

async fn release(
    State(state): State<std::sync::Arc<super::store_admin::AdminState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(kv) = ready_store(&state) else {
        return unavailable();
    };
    let (Some(account), Some(hash)) = (account(&body), hash(&body)) else {
        return bad_request("release exige accountScope e infoHash válidos");
    };
    write(kv.forget(&hold_key(account, hash)))
}

async fn accept(
    State(state): State<std::sync::Arc<super::store_admin::AdminState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(kv) = ready_store(&state) else {
        return unavailable();
    };
    let (Some(account), Some(hash)) = (account(&body), hash(&body)) else {
        return bad_request("accept exige accountScope e infoHash válidos");
    };
    if body.get("accepted").and_then(Value::as_bool) != Some(true)
        || body.get("snapshotComplete").and_then(Value::as_bool) != Some(true)
        || body.get("preexisting").and_then(Value::as_bool) != Some(false)
    {
        return conflict("posse exige upload aceito e snapshot completo provando hash novo");
    }
    let Some(ownership_ttl) = ttl(&body, "ownershipTtlSeconds", OWNERSHIP_TTL_MAX) else {
        return bad_request("ownershipTtlSeconds inválido");
    };
    let protect_br = body.get("protectBr").and_then(Value::as_bool) == Some(true);
    if protect_br && body.get("pool").and_then(Value::as_str) != Some("br") {
        return conflict("adprot só pode ser criado para o pool BR");
    }
    let protect_ttl = if protect_br {
        let Some(ttl) = ttl(&body, "protectTtlSeconds", OWNERSHIP_TTL_MAX) else {
            return bad_request("protectTtlSeconds inválido");
        };
        ttl
    } else {
        0
    };

    let at = now_ms();
    let sub_key = submitted_key(account, hash);
    let sub_value = json!({ "at": at });
    let hold_key = hold_key(account, hash);
    let mut writes = vec![KvWrite {
        key: &sub_key,
        value: &sub_value,
        ttl_seconds: ownership_ttl,
        now_ms: at,
        only_if_absent: false,
    }];
    let prot_key = protect_key(account, hash);
    let prot_value = json!({ "acceptedAt": at, "readyAt": null });
    if protect_br {
        writes.push(KvWrite {
            key: &prot_key,
            value: &prot_value,
            ttl_seconds: protect_ttl,
            now_ms: at,
            only_if_absent: true,
        });
    }
    match kv.put_many_json_and_forget(&writes, &[&hold_key]) {
        Ok(()) => {
            Json(json!({ "ok": true, "owned": true, "protected": protect_br })).into_response()
        }
        Err(err) => storage_error(err),
    }
}

async fn ready(
    State(state): State<std::sync::Arc<super::store_admin::AdminState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(kv) = ready_store(&state) else {
        return unavailable();
    };
    let (Some(account), Some(hash), Some(ttl)) = (
        account(&body),
        hash(&body),
        ttl(&body, "protectTtlSeconds", OWNERSHIP_TTL_MAX),
    ) else {
        return bad_request("ready exige accountScope, infoHash e protectTtlSeconds válido");
    };
    if body.get("adapter").and_then(Value::as_str) != Some("alldebrid") {
        return bad_request("proteção durável só aceita adapter alldebrid");
    }
    let _guard = mutation_lock();
    let key = protect_key(account, hash);
    let prior = match kv.get_json(&key, now_ms()) {
        Ok(Some(value)) => value,
        Ok(None) => return conflict("não há adprot pendente para este hash"),
        Err(err) => return storage_error(err),
    };
    let Some(accepted_at) = prior.get("acceptedAt").and_then(Value::as_i64) else {
        return storage_error("registro adprot ilegível: acceptedAt ausente".into());
    };
    write(kv.put_json(
        &key,
        &json!({ "acceptedAt": accepted_at, "readyAt": now_ms() }),
        ttl,
        now_ms(),
    ))
}

async fn unprotect(
    State(state): State<std::sync::Arc<super::store_admin::AdminState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(kv) = ready_store(&state) else {
        return unavailable();
    };
    let (Some(account), Some(hash)) = (account(&body), hash(&body)) else {
        return bad_request("unprotect exige accountScope e infoHash válidos");
    };
    if body.get("adapter").and_then(Value::as_str) != Some("alldebrid") {
        return bad_request("unprotect só aceita adapter alldebrid");
    }
    let _guard = mutation_lock();
    write(kv.forget(&protect_key(account, hash)))
}

async fn reupload_unblock(
    State(state): State<std::sync::Arc<super::store_admin::AdminState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(kv) = ready_store(&state) else {
        return unavailable();
    };
    let (Some(account), Some(hash)) = (account(&body), hash(&body)) else {
        return bad_request("reupload-unblock exige accountScope e infoHash válidos");
    };
    write(kv.forget(&reupload_key(account, hash)))
}

/// Confirma a saída intencional em um só commit local: registra `adrm` e apaga
/// as marcas que não podem sobreviver a uma remoção (`adsub`, `adprot`, hold).
async fn deleted(
    State(state): State<std::sync::Arc<super::store_admin::AdminState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(kv) = ready_store(&state) else {
        return unavailable();
    };
    let (Some(account), Some(hash), Some(ttl)) = (
        account(&body),
        hash(&body),
        ttl(&body, "ttlSeconds", REUPLOAD_TTL_MAX),
    ) else {
        return bad_request("deleted exige accountScope, infoHash e ttlSeconds válido");
    };
    if body.get("deleteConfirmed").and_then(Value::as_bool) != Some(true) {
        return conflict("marcas só podem mudar após remoção confirmada");
    }
    if !br_origin_proven_non_br(&body) {
        return conflict("origem BR precisa ser comprovadamente falsa para marcar adrm");
    }
    // O flag é do chamador; o nome é o que o `markReuploadBlocked` do TS olha.
    // Release com marca de origem BR no próprio nome nunca recebe `adrm`.
    if name_has_br_mark(&body) {
        return conflict("nome com marca de origem BR não pode receber adrm");
    }
    let mut value = json!({ "at": now_ms() });
    if let Some(name) = body
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        value["name"] = json!(name.chars().take(160).collect::<String>());
    }
    let key = reupload_key(account, hash);
    let now = now_ms();
    let write = [KvWrite {
        key: &key,
        value: &value,
        ttl_seconds: ttl,
        now_ms: now,
        only_if_absent: false,
    }];
    let sub = submitted_key(account, hash);
    let prot = protect_key(account, hash);
    let held = hold_key(account, hash);
    let _guard = mutation_lock();
    match kv.put_many_json_and_forget(&write, &[&sub, &prot, &held]) {
        Ok(()) => {
            Json(json!({ "ok": true, "blocked": true, "ownershipCleared": true })).into_response()
        }
        Err(err) => storage_error(err),
    }
}

fn ready_store(state: &super::store_admin::AdminState) -> Option<&NativeKv> {
    state.ownership_kv.as_deref()
}

fn account(body: &Value) -> Option<&str> {
    let account = body.get("accountScope")?.as_str()?.trim();
    (account.len() == 64 && account.bytes().all(|b| b.is_ascii_hexdigit())).then_some(account)
}

fn hash(body: &Value) -> Option<&str> {
    let hash = body.get("infoHash")?.as_str()?.trim();
    (hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hash)
}

fn ttl(body: &Value, field: &str, max: i64) -> Option<i64> {
    body.get(field)
        .and_then(Value::as_i64)
        .filter(|ttl| *ttl > 0 && *ttl <= max)
}

fn name_has_br_mark(body: &Value) -> bool {
    body.get("name")
        .and_then(Value::as_str)
        .is_some_and(adom_core::br_origin_mark)
}

fn br_origin_proven_non_br(body: &Value) -> bool {
    body.get("brOrigin").and_then(Value::as_bool) == Some(false)
}

fn hold_key(account: &str, hash: &str) -> String {
    format!(
        "adhold:v1:{}:{}",
        account.to_ascii_lowercase(),
        hash.to_ascii_lowercase()
    )
}

fn submitted_key(account: &str, hash: &str) -> String {
    format!(
        "adsub:v1:{}:{}",
        account.to_ascii_lowercase(),
        hash.to_ascii_lowercase()
    )
}

fn protect_key(account: &str, hash: &str) -> String {
    format!(
        "adprot:v1:alldebrid:{}:{}",
        account.to_ascii_lowercase(),
        hash.to_ascii_lowercase()
    )
}

fn reupload_key(account: &str, hash: &str) -> String {
    format!(
        "adrm:v1:{}:{}",
        account.to_ascii_lowercase(),
        hash.to_ascii_lowercase()
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn write<T: serde::Serialize>(result: Result<T, String>) -> Response {
    match result {
        Ok(value) => Json(json!({ "ok": true, "result": value })).into_response(),
        Err(err) => storage_error(err),
    }
}

/// Sem KV aberto o gateway não sabe nada da posse: 503, nunca 400 (o chamador
/// não errou o corpo, o servidor é que não pode gravar).
fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "ok": false, "error": "ownership_store_unavailable" })),
    )
        .into_response()
}

fn bad_request(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}

fn conflict(message: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({ "ok": false, "error": message })),
    )
        .into_response()
}

fn storage_error(message: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": "ownership_store_failed", "detail": message })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "ownership_admin_tests.rs"]
mod tests;
