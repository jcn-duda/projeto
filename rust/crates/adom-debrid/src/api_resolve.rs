//! POST /debrid/resolve. Faz o que `/debrid/link` faz (via `play`, os cinco
//! adaptadores) e, na falha do adaptador, devolve o efeito. Não grava magnetdb,
//! cache nem ledger.

use std::sync::Arc;
use std::time::Duration;

use adom_core::{PlayHint, WorkHint};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::AppState;
use crate::error::DebridError;
use crate::play;
use crate::resolve_effects::resolve_effect;

const POLL_WAIT: Duration = Duration::from_millis(700);

#[derive(Deserialize)]
struct RequestBody {
    service: String,
    #[serde(default, rename = "apiKey")]
    api_key: String,
    #[serde(default)]
    hash: String,
    #[serde(default)]
    episode: Option<Value>,
}

pub(super) async fn post(State(state): State<Arc<AppState>>, raw: Bytes) -> Response {
    let Some(body) = serde_json::from_slice::<RequestBody>(&raw).ok() else {
        return bad_json();
    };
    eprintln!("[debrid] resolve service={}", plain(&body.service));
    if !known(&body.service) {
        state.metrics.inc("rust.debrid.api.unknown_service");
        return json_status(
            StatusCode::BAD_REQUEST,
            json!({ "error": "unknown_service" }),
        );
    }
    if !link_service(&body.service) {
        state.metrics.inc("rust.debrid.api.not_ported");
        return json_status(
            StatusCode::NOT_IMPLEMENTED,
            json!({ "error": "service_not_ported", "service": body.service }),
        );
    }
    let Some(client) = state.http.clone() else {
        state.metrics.inc("rust.debrid.api.adapter_error");
        eprintln!("[debrid] cliente http ausente");
        return json_status(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "other", "kind": "other", "message": "cliente http indisponivel" }),
        );
    };
    let hint = play_hint(&body.episode);
    match play::resolve_with_wait(
        &body.service,
        &body.api_key,
        &body.hash,
        &hint,
        client,
        POLL_WAIT,
    )
    .await
    {
        Ok(outcome) => json_status(StatusCode::OK, json!({ "url": outcome.url })),
        Err(err) => effect_response(&state, &body.service, &err),
    }
}

fn effect_response(state: &AppState, service: &str, err: &DebridError) -> Response {
    state.metrics.inc("rust.debrid.api.adapter_error");
    eprintln!(
        "[debrid] resolve service={} kind={}",
        plain(service),
        err.kind()
    );
    let body = resolve_effect(service, err);
    let code = body
        .get("status")
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
        .unwrap_or(502);
    let status = StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY);
    json_status(status, body)
}

fn known(service: &str) -> bool {
    matches!(
        service,
        "premiumize" | "realdebrid" | "alldebrid" | "torbox" | "debridlink"
    )
}

fn link_service(service: &str) -> bool {
    play::known_service(service)
}

fn play_hint(raw: &Option<Value>) -> PlayHint {
    let Some(Value::Object(map)) = raw else {
        return PlayHint::default();
    };
    PlayHint {
        season: json_i64(map.get("season")),
        episode: json_i64(map.get("episode")),
        work: map.get("work").and_then(work_hint),
        dubbed: map.get("dubbed").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn work_hint(value: &Value) -> Option<WorkHint> {
    let map = value.as_object()?;
    let names = map.get("names").and_then(Value::as_array).map(|list| {
        list.iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect()
    });
    Some(WorkHint {
        names: names.unwrap_or_default(),
        year: json_i64(map.get("year")),
        pack: map.get("pack").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().filter(|n| n.is_finite()).map(|n| n as i64)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn plain(service: &str) -> String {
    service
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect()
}

fn json_status(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

fn bad_json() -> Response {
    json_status(StatusCode::BAD_REQUEST, json!({ "error": "bad_request" }))
}
