//! Rotas administrativas do colhedor — montadas no `store_admin` (loopback +
//! `X-Indexer-Test-Token`). NÃO há servidor novo.
//!
//! | rota | efeito |
//! |---|---|
//! | `GET /harvest` | snapshot da fila/worker (mesmo formato do painel) |
//! | `POST /harvest/enqueue` | enfileira uma obra (dedupe 12 h incluso) |
//! | `POST /harvest/pause` | pausa/retoma o ciclo |
//! | `POST /harvest/config` | aplica os overrides do painel (`live.rs`) |
//! | `POST /harvest/drain` | pede até N drains AGORA (via loop) |
//! | `POST /harvest/clear` | limpa a fila (o balde horário NÃO zera) |
//! | `GET /harvest/pending` | a obra está na fila? é sonda? |
//!
//! `harvest: None` (colhedor desligado/store indisponível) responde o mesmo
//! contrato com `enabled:false`, `disabled` no enqueue e `0` nos efeitos: o
//! Node não precisa de caminho especial.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use adom_harvest::{is_valid_imdb_id, EnqueueReason, HarvestMediaType, HarvestRequest};

use crate::store_admin::AdminState;

/// Rotas do colhedor (o `auth` do `store_admin` já cobre todas).
pub(crate) fn router() -> Router<Arc<AdminState>> {
    Router::new()
        .route("/harvest", get(status_now))
        .route("/harvest/enqueue", post(enqueue))
        .route("/harvest/pause", post(pause))
        .route("/harvest/config", post(apply_config))
        .route("/harvest/drain", post(drain))
        .route("/harvest/clear", post(clear))
        .route("/harvest/pending", get(pending))
}

/// `GET /harvest` — foto sem esperar drain (o snapshot é do último ciclo).
async fn status_now(State(state): State<Arc<AdminState>>) -> Response {
    let Some(handle) = state.harvest.as_ref() else {
        return Json(json!({
            "ok": true,
            "enabled": false,
            "paused": false,
            "intervalMs": 0,
            "maxPerHour": 0,
            "queriesThisHour": 0,
            "depth": 0,
            "inflight": false,
            "preview": [],
            "last": [],
            "counters": { "drained": 0, "failed": 0 },
            // Sem colhedor (`HARVEST_ENABLED=false`) não há store a degradar.
            "degraded": false,
            "storeError": null,
            "store": "",
        }))
        .into_response();
    };
    let status = handle.status();
    let config = handle.config();
    Json(json!({
        "ok": true,
        // A thread existe (`.env`); `enabled` é o efetivo, com o painel.
        "enabled": config.enabled,
        "paused": status.paused,
        "intervalMs": config.interval_ms,
        "maxPerHour": config.max_per_hour,
        "idleWindowMs": config.idle_window_ms,
        "queueMax": config.queue_max,
        "queriesThisHour": status.queries_this_hour,
        "depth": status.depth,
        "inflight": status.inflight,
        "preview": status.preview,
        "last": status.last,
        "counters": status.counters,
        // Arquivo podre no boot: a fila está vazia porque o L2 foi quarentenado.
        "degraded": status.degraded,
        "storeError": status.store_error,
        "store": handle.store_path().to_string_lossy(),
    }))
    .into_response()
}

/// `POST /harvest/enqueue` — `{imdbId,type,season?,episode?,reason,brProbe?}`.
async fn enqueue(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    let Some(request) = request_from_body(&body) else {
        return Json(json!({
            "ok": true,
            "accepted": false,
            "reason": EnqueueReason::Invalid.as_str(),
        }))
        .into_response();
    };
    let Some(handle) = state.harvest.as_ref() else {
        return Json(json!({
            "ok": true,
            "accepted": false,
            "reason": EnqueueReason::Disabled.as_str(),
        }))
        .into_response();
    };
    let outcome = handle.enqueue(request).await;
    Json(json!({
        "ok": true,
        "accepted": outcome.accepted,
        "reason": outcome.reason.as_str(),
    }))
    .into_response()
}

/// Corpo do enqueue → pedido. `None` = `imdbId`/`type`/`reason` inválidos.
///
/// O `type` é validado pelo enum (só `movie`/`series`); série sem temporada
/// continua válida (a fila aceita obra sem S/E, como o TS).
pub(super) fn request_from_body(body: &Value) -> Option<HarvestRequest> {
    let imdb = body.get("imdbId").and_then(Value::as_str).unwrap_or("");
    let media_type = HarvestMediaType::parse(body.get("type").and_then(Value::as_str)?)?;
    let reason = body.get("reason").and_then(Value::as_str).unwrap_or("");
    if !is_valid_imdb_id(imdb) || reason.trim().is_empty() {
        return None;
    }
    Some(HarvestRequest {
        imdb_id: imdb.to_string(),
        media_type,
        season: body
            .get("season")
            .and_then(Value::as_i64)
            .and_then(|v| i32::try_from(v).ok()),
        episode: body
            .get("episode")
            .and_then(Value::as_i64)
            .and_then(|v| i32::try_from(v).ok()),
        reason: reason.to_string(),
        br_probe: body
            .get("brProbe")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

/// `POST /harvest/pause` — `{"paused":bool}`.
async fn pause(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    let paused = body.get("paused").and_then(Value::as_bool).unwrap_or(false);
    let applied = match state.harvest.as_ref() {
        Some(handle) => {
            handle.set_paused(paused);
            paused
        }
        None => false,
    };
    Json(json!({ "ok": true, "paused": applied })).into_response()
}

/// `POST /harvest/config` — o objeto de overrides do painel (o mesmo que o
/// Node grava em `cfg:v1:harvester`; `{}` = tudo no `.env`). Devolve o efetivo.
async fn apply_config(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    let Some(handle) = state.harvest.as_ref() else {
        return Json(json!({ "ok": true, "applied": false })).into_response();
    };
    if !body.is_object() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "overrides devem ser um objeto" })),
        )
            .into_response();
    }
    let config = handle.apply_live(&body);
    Json(json!({
        "ok": true,
        "applied": true,
        "enabled": config.enabled,
        "paused": handle.status().paused,
        "intervalMs": config.interval_ms,
        "maxPerHour": config.max_per_hour,
        "idleWindowMs": config.idle_window_ms,
        "queueMax": config.queue_max,
    }))
    .into_response()
}

/// `POST /harvest/drain` — `{"max":5}`; o loop executa (o handler não roda o
/// `tick_async`, que não é `Send`).
async fn drain(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    let max = body
        .get("max")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .min(u64::from(u32::MAX)) as usize;
    let drained = match state.harvest.as_ref() {
        Some(handle) => handle.drain(max).await,
        None => 0,
    };
    Json(json!({ "ok": true, "drained": drained })).into_response()
}

/// `POST /harvest/clear` — corpo vazio ou `{}`.
async fn clear(State(state): State<Arc<AdminState>>, _body: Option<Json<Value>>) -> Response {
    let cleared = match state.harvest.as_ref() {
        Some(handle) => handle.clear().await,
        None => 0,
    };
    Json(json!({ "ok": true, "cleared": cleared })).into_response()
}

/// `GET /harvest/pending?imdbId=tt…` — qualquer entrada da obra conta.
async fn pending(
    State(state): State<Arc<AdminState>>,
    Query(params): Query<BTreeMap<String, String>>,
) -> Response {
    let imdb = params.get("imdbId").map(String::as_str).unwrap_or("");
    if !is_valid_imdb_id(imdb) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "imdbId obrigatório" })),
        )
            .into_response();
    }
    let (queued, br_probe) = match state.harvest.as_ref() {
        Some(handle) => handle.pending(imdb).await,
        None => (false, false),
    };
    Json(json!({ "ok": true, "queued": queued, "brProbe": br_probe })).into_response()
}
