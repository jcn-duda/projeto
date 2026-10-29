//! Rotas administrativas do warmer RD na API do gateway (`127.0.0.1:8711`).
//!
//! Montadas no `store_admin`: o `auth` de lá (loopback, token e 503 sem token)
//! já cobre estas rotas — aqui NÃO existe autenticação própria nem servidor
//! novo. Toda resposta é JSON e nenhuma carrega apiKey, escopo de conta ou
//! hash: o status é operacional.
//!
//! | rota | efeito |
//! |---|---|
//! | `GET /rd-warm` | fila, quota, pausa, contadores (só memória) |
//! | `POST /rd-warm/pause` | pausa o tick/dreno (token DESTRUTIVO) |
//! | `POST /rd-warm/resume` | retoma (token DESTRUTIVO) |
//! | `POST /rd-warm/drain` `{"confirm":true,"max":N}` | drena AGORA (token DESTRUTIVO + confirm) |
//!
//! O `GET` nunca faz I/O na conta e responde 200 mesmo com o warmer desligado
//! (`enabled:false` + `reason`). O `POST` recusa antes de tocar a fila: sem a
//! segunda credencial (`STREAM_STORE_ADMIN_TOKEN`/`DEBRID_INTERNAL_TOKEN`)
//! devolve 409; com o token de diagnóstico, 403. O dreno exige `confirm:true`
//! no corpo — o `max` é o teto da rodada (0/ausente = lote padrão).

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::store_admin::{tokens_match, AdminState};

pub(crate) fn router() -> Router<Arc<AdminState>> {
    Router::new()
        .route("/rd-warm", get(status))
        .route("/rd-warm/pause", post(pause))
        .route("/rd-warm/resume", post(resume))
        .route("/rd-warm/drain", post(drain))
}

async fn status(State(state): State<Arc<AdminState>>) -> Response {
    let Some(warmer) = state.warmer.as_ref() else {
        return Json(json!({
            "ok": true,
            "enabled": false,
            "paused": false,
            "queueDepth": 0,
            "queueMax": 0,
            "batch": 0,
            "maxPerHour": 0,
            "queriesThisHour": 0,
            "intervalMs": 0,
            "idleWindowMs": 0,
            "inFlight": false,
            "lastTickAt": null,
            "accountSource": "none",
            "counters": counters_json(Default::default()),
            "reason": "disabled",
        }))
        .into_response();
    };
    let s = warmer.status();
    Json(json!({
        "ok": true,
        "enabled": s.enabled,
        "paused": s.paused,
        "queueDepth": s.queue_depth,
        "queueMax": s.queue_max,
        "batch": s.batch,
        "maxPerHour": s.max_per_hour,
        "queriesThisHour": s.queries_this_hour,
        "intervalMs": s.interval_ms,
        "idleWindowMs": s.idle_window_ms,
        "inFlight": s.in_flight,
        "lastTickAt": s.last_tick_at,
        "accountSource": s.account_source,
        "counters": counters_json(s.counters),
        "reason": Value::Null,
    }))
    .into_response()
}

async fn pause(State(state): State<Arc<AdminState>>, headers: HeaderMap) -> Response {
    if let Some(refusal) = destructive(&state, &headers) {
        return refusal;
    }
    let Some(warmer) = state.warmer.as_ref() else {
        return fail(StatusCode::CONFLICT, "rd_warm_disabled", Some("disabled"));
    };
    warmer.set_paused(true);
    Json(json!({ "ok": true, "paused": true })).into_response()
}

async fn resume(State(state): State<Arc<AdminState>>, headers: HeaderMap) -> Response {
    if let Some(refusal) = destructive(&state, &headers) {
        return refusal;
    }
    let Some(warmer) = state.warmer.as_ref() else {
        return fail(StatusCode::CONFLICT, "rd_warm_disabled", Some("disabled"));
    };
    warmer.set_paused(false);
    Json(json!({ "ok": true, "paused": false })).into_response()
}

async fn drain(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(refusal) = destructive(&state, &headers) {
        return refusal;
    }
    let body = body.map(|Json(value)| value).unwrap_or(Value::Null);
    if body.get("confirm").and_then(Value::as_bool) != Some(true) {
        return fail(StatusCode::CONFLICT, "confirmation_required", None);
    }
    let Some(warmer) = state.warmer.as_ref() else {
        return fail(StatusCode::CONFLICT, "rd_warm_disabled", Some("disabled"));
    };
    // `max` é o teto da rodada; 0/ausente mantém o lote padrão.
    let max = body
        .get("max")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 500) as usize)
        .unwrap_or(0);
    let processed = warmer.drain_admin(max).await;
    Json(json!({
        "ok": true,
        "processed": processed,
        "queueRemaining": warmer.pending(),
    }))
    .into_response()
}

/// A credencial DESTRUTIVA é a do `store_admin` (`STREAM_STORE_ADMIN_TOKEN` →
/// `DEBRID_INTERNAL_TOKEN`). O token de diagnóstico abre o `GET`, não a fila.
fn destructive(state: &AdminState, headers: &HeaderMap) -> Option<Response> {
    let Some(expected) = state.destructive_token.as_deref() else {
        return Some(fail(
            StatusCode::CONFLICT,
            "rd_warm_requires_admin_token",
            Some("no_destructive_token"),
        ));
    };
    if !tokens_match(expected, header_token(headers)) {
        return Some(fail(
            StatusCode::FORBIDDEN,
            "rd_warm_token_insufficient",
            Some("diagnostic_token"),
        ));
    }
    None
}

fn header_token(headers: &HeaderMap) -> &str {
    headers
        .get("x-indexer-test-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

fn counters_json(value: crate::rd_warmer::Counters) -> Value {
    json!({
        "enqueued": value.enqueued,
        "skipped": value.skipped,
        "droppedFull": value.dropped_full,
        "droppedNoKey": value.dropped_no_key,
        "probes": value.probes,
        "hits": value.hits,
        "misses": value.misses,
        "blocked": value.blocked,
        "stopped": value.stopped,
    })
}

fn fail(status: StatusCode, error: &'static str, reason: Option<&'static str>) -> Response {
    let mut body = json!({ "ok": false, "error": error });
    if let Some(reason) = reason {
        body["reason"] = json!(reason);
    }
    (status, Json(body)).into_response()
}
