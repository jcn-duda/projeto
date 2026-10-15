//! Despacho das rotas internas. O adaptador nasce por pedido e lê a base do
//! ambiente. Magnet ausente é `None`: o `default_magnet` fica no adaptador.

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
use crate::debridlink::DebridLink;
use crate::error::DebridError;
use crate::http::HttpClient;
use crate::premiumize::Premiumize;
use crate::realdebrid::RealDebrid;

fn known(service: &str) -> bool {
    matches!(
        service,
        "premiumize" | "realdebrid" | "alldebrid" | "torbox" | "debridlink"
    )
}

const POLL_WAIT: Duration = Duration::from_millis(700); // espera do pollTorrent em produção

#[derive(Deserialize)]
struct RequestBody {
    service: String,
    #[serde(default)]
    hashes: Vec<String>,
    #[serde(default, rename = "apiKey")]
    api_key: String,
    #[serde(default, rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(default, rename = "fileHashes")]
    file_hashes: Vec<String>,
    #[serde(default, rename = "fileWaitTimeoutMs")]
    file_wait_timeout_ms: Option<u64>,
    #[serde(default)]
    hash: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    episode: Option<Value>,
}

pub(super) async fn check(State(state): State<Arc<AppState>>, raw: Bytes) -> Response {
    let Some(body) = parse_body(&raw) else {
        return bad_json();
    };
    // fileHashes no TS dispara directdl. A checagem daqui não escreve na conta.
    let _ = (&body.file_hashes, body.file_wait_timeout_ms);
    eprintln!(
        "[debrid] check service={} hashes={}",
        plain(&body.service),
        body.hashes.len()
    );
    if let Some(response) = reject_unknown(&state, &body.service) {
        return response;
    }
    match body.service.as_str() {
        "premiumize" => premiumize_check(&state, &body).await,
        "debridlink" => debridlink_check(&state, &body).await,
        // realdebrid: sem known(hash) no POST e sem leitura do ledger rdc.
        _ => not_ported(&state, &body.service),
    }
}

pub(super) async fn link(State(state): State<Arc<AppState>>, raw: Bytes) -> Response {
    let Some(body) = parse_body(&raw) else {
        return bad_json();
    };
    eprintln!("[debrid] link service={}", plain(&body.service));
    if let Some(response) = reject_unknown(&state, &body.service) {
        return response;
    }
    let hint = play_hint(&body.episode);
    if !link_service(&body.service) {
        return not_ported(&state, &body.service);
    }
    let client = match http(&state) {
        Ok(client) => client,
        Err(response) => return *response,
    };
    let result = resolve(&body, client, &hint).await;
    finish(&state, &body, result, |url| match url {
        Some(url) => json!({ "url": url }),
        None => Value::Null,
    })
}

pub(super) async fn account(State(state): State<Arc<AppState>>, raw: Bytes) -> Response {
    let Some(body) = parse_body(&raw) else {
        return bad_json();
    };
    eprintln!("[debrid] account service={}", plain(&body.service));
    if let Some(response) = reject_unknown(&state, &body.service) {
        return response;
    }
    let Some(status) = account_of(&state, &body).await else {
        return not_ported(&state, &body.service);
    };
    status
}

pub(super) async fn files(State(state): State<Arc<AppState>>, raw: Bytes) -> Response {
    let Some(body) = parse_body(&raw) else {
        return bad_json();
    };
    eprintln!("[debrid] files service={}", plain(&body.service));
    if let Some(response) = reject_unknown(&state, &body.service) {
        return response;
    }
    if body.service != "premiumize" {
        return not_ported(&state, &body.service);
    }
    let client = match http(&state) {
        Ok(client) => client,
        Err(response) => return *response,
    };
    let result = Premiumize::new(client)
        .fresh_file_link(&body.api_key, &body.hash, &body.path, None)
        .await;
    finish(&state, &body, result, |link| match link {
        Some(link) => json!({ "url": link.url, "size": link.size }),
        None => Value::Null,
    })
}

async fn premiumize_check(state: &AppState, body: &RequestBody) -> Response {
    let client = match http(state) {
        Ok(client) => client,
        Err(response) => return *response,
    };
    let timeout = body.timeout_ms.map(Duration::from_millis);
    let result = Premiumize::new(client)
        .check_cached(&body.api_key, &body.hashes, timeout)
        .await;
    finish(
        state,
        body,
        result,
        |report| json!({ "cached": report.cached, "complete": report.complete }),
    )
}

async fn debridlink_check(state: &AppState, body: &RequestBody) -> Response {
    let client = match http(state) {
        Ok(client) => client,
        Err(response) => return *response,
    };
    // Não faz HTTP: lista vazia é a resposta completa, não um peek faltando.
    let result = DebridLink::new(client).check_cached().await;
    finish(
        state,
        body,
        result,
        |cached| json!({ "cached": cached, "complete": true }),
    )
}

fn link_service(service: &str) -> bool {
    matches!(service, "premiumize" | "debridlink" | "realdebrid")
}

async fn resolve(
    body: &RequestBody,
    client: HttpClient,
    hint: &PlayHint,
) -> Result<Option<String>, DebridError> {
    match body.service.as_str() {
        "premiumize" => {
            Premiumize::new(client)
                .resolve_link(&body.api_key, &body.hash, hint, None)
                .await
        }
        "debridlink" => {
            DebridLink::new(client)
                .resolve_link(&body.api_key, &body.hash, hint, None, POLL_WAIT)
                .await
        }
        _ => {
            RealDebrid::new(client)
                .resolve_link(&body.api_key, &body.hash, hint, None, POLL_WAIT)
                .await
        }
    }
}

async fn account_of(state: &AppState, body: &RequestBody) -> Option<Response> {
    let client = match body.service.as_str() {
        "premiumize" | "realdebrid" => match http(state) {
            Ok(client) => client,
            Err(response) => return Some(*response),
        },
        // Debrid-Link não tem account_status.
        _ => return None,
    };
    Some(match body.service.as_str() {
        "premiumize" => {
            let result = Premiumize::new(client).account_status(&body.api_key).await;
            finish(
                state,
                body,
                result,
                |status| json!({ "limitUsed": status.limit_used, "premiumUntil": status.premium_until }),
            )
        }
        _ => {
            let result = RealDebrid::new(client).account_status(&body.api_key).await;
            finish(state, body, result, |status| {
                json!({
                    "magnets": status.magnets,
                    "ready": status.ready,
                    "active": status.active,
                    "error": status.error,
                    "premiumUntil": status.premium_until,
                })
            })
        }
    })
}

fn finish<T>(
    state: &AppState,
    body: &RequestBody,
    result: Result<T, DebridError>,
    ok: impl FnOnce(T) -> Value,
) -> Response {
    match result {
        Ok(value) => json_status(StatusCode::OK, ok(value)),
        Err(err) => adapter_error(state, &body.service, &body.api_key, err),
    }
}

fn http(state: &AppState) -> Result<HttpClient, Box<Response>> {
    state.http.clone().ok_or_else(|| Box::new(client_missing(state)))
}

fn parse_body(raw: &[u8]) -> Option<RequestBody> {
    serde_json::from_slice(raw).ok()
}

fn play_hint(raw: &Option<Value>) -> PlayHint {
    let Some(Value::Object(map)) = raw else {
        return PlayHint::default();
    };
    PlayHint {
        season: json_i64(map.get("season")),
        episode: json_i64(map.get("episode")),
        work: map.get("work").and_then(work_hint),
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

fn reject_unknown(state: &AppState, service: &str) -> Option<Response> {
    if known(service) {
        return None;
    }
    state.metrics.inc("rust.debrid.api.unknown_service");
    Some(json_status(
        StatusCode::BAD_REQUEST,
        json!({ "error": "unknown_service" }),
    ))
}

fn not_ported(state: &AppState, service: &str) -> Response {
    state.metrics.inc("rust.debrid.api.not_ported");
    json_status(
        StatusCode::NOT_IMPLEMENTED,
        json!({ "error": "service_not_ported", "service": service }),
    )
}

fn client_missing(state: &AppState) -> Response {
    state.metrics.inc("rust.debrid.api.adapter_error");
    eprintln!("[debrid] cliente http ausente");
    json_status(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": "other", "kind": "other", "message": "cliente http indisponivel" }),
    )
}

fn adapter_error(state: &AppState, service: &str, secret: &str, err: DebridError) -> Response {
    state.metrics.inc("rust.debrid.api.adapter_error");
    // Só o tipo: a mensagem do upstream pode carregar a URL com a chave.
    eprintln!(
        "[debrid] falha service={} kind={}",
        plain(service),
        err.kind()
    );
    let message = redact(err.message(), secret);
    let message = if message.trim().is_empty() {
        "falha no debrid".into()
    } else {
        message
    };
    json_status(
        play_status(&err),
        json!({
            "error": err.kind(),
            "kind": err.kind(),
            "message": message,
        }),
    )
}

/// 401 fica com o token interno. Cada erro de play tem status próprio;
/// o que sobra é 500, e NoVideo não entra aí.
fn play_status(err: &DebridError) -> StatusCode {
    match err.kind() {
        "auth" => StatusCode::FORBIDDEN,
        "quota" => StatusCode::PAYMENT_REQUIRED,
        "rate_limit" => StatusCode::TOO_MANY_REQUESTS,
        "blocked" => StatusCode::UNAVAILABLE_FOR_LEGAL_REASONS,
        "no_video" => StatusCode::UNPROCESSABLE_ENTITY,
        "episode_pick" => StatusCode::CONFLICT,
        "work_pick" => StatusCode::PRECONDITION_FAILED,
        "dub_lie" => StatusCode::NOT_ACCEPTABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn redact(message: &str, secret: &str) -> String {
    let text = if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "[redacted]")
    };
    strip_query_key(&strip_query_key(&text, "apikey="), "apiKey=")
}

fn strip_query_key(text: &str, marker: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(marker) {
        out.push_str(&rest[..index]);
        out.push_str(marker);
        out.push_str("[redacted]");
        rest = &rest[index + marker.len()..];
        let skip = rest.find(['&', ' ', '"', '\'']).unwrap_or(rest.len());
        rest = &rest[skip..];
    }
    out.push_str(rest);
    out
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
