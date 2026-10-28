use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::store_admin::AdminState;

pub(crate) fn router() -> Router<Arc<AdminState>> {
    Router::new()
        .route("/autofetch", get(status))
        .route("/autofetch/config", post(config))
        .route("/autofetch/pause", post(pause))
        .route("/autofetch/drain", post(drain))
        .route("/autofetch/suppressed-drain", post(suppressed_drain))
}

async fn status(State(state): State<Arc<AdminState>>) -> Response {
    match state.autofetch.as_ref() {
        Some(handle) => Json(json!({ "ok": true, "status": handle.status() })).into_response(),
        // Sem worker (store indisponível) o contrato continua legível: o painel
        // vê `phase:"unavailable"` em vez de erro.
        None => Json(json!({
            "ok": true,
            "status": {
                "enabled": false,
                "phase": "unavailable",
                "paused": false,
                "queueDepth": 0,
                "lots": 0,
                "inflight": false,
                "intervalMs": 60_000
            }
        }))
        .into_response(),
    }
}

async fn config(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    let Some(handle) = state.autofetch.as_ref() else {
        return unavailable();
    };
    let Some(config) = super::worker::parse_config(&body, &handle.config()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "configuração inválida ou campo não permitido" })),
        )
            .into_response();
    };
    match handle.update(config) {
        Ok(status) => Json(json!({ "ok": true, "status": status })).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": "configuração não persistida" })),
        )
            .into_response(),
    }
}

async fn pause(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    if body
        .as_object()
        .is_none_or(|obj| obj.len() != 1 || !obj.contains_key("paused"))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "pause exige somente o campo paused booleano" })),
        )
            .into_response();
    }
    config(State(state), Json(json!({ "paused": body["paused"] }))).await
}

/// Dreno da fase B. Hoje responde o contrato sem efeito: nenhuma entrada da
/// fila é tocada, nenhum debrid é chamado. Sem worker no processo não há
/// contrato a cumprir — a resposta é o 503 de sempre.
async fn drain(State(state): State<Arc<AdminState>>) -> Response {
    not_enabled(&state, "drain")
}

async fn suppressed_drain(State(state): State<Arc<AdminState>>) -> Response {
    not_enabled(&state, "suppressed-drain")
}

fn not_enabled(state: &AdminState, operation: &str) -> Response {
    if state.autofetch.is_none() {
        return unavailable();
    }
    Json(json!({
        "ok": true,
        "enabled": false,
        "phase": "prepared",
        "operation": operation,
        "effect": "none",
        "drained": 0
    }))
    .into_response()
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "ok": false, "error": "autofetch_worker_unavailable" })),
    )
        .into_response()
}
