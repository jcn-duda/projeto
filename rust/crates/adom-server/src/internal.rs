//! Rotas internas que o sidecar do raspador consome (antes servidas pelo
//! Node): o freio de tráfego e a entrega da página raspada. Mais o
//! `/acervo.json` de diagnóstico. Todas exigem `X-Indexer-Test-Token`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use adom_crawl::motor::types::{CrawlResultStatus, CrawlWorkResult};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::acervo::Acervo;

const TOKEN_HEADER: &str = "x-indexer-test-token";

pub struct Internal {
    pub token: String,
    pub acervo: Acervo,
    /// Última requisição de usuário (fora de `/internal` e `/health`), em ms.
    pub last_user_ms: AtomicI64,
}

pub type InternalState = Arc<Internal>;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// O que conta como tráfego de usuário para o freio do raspador.
pub fn is_user_path(path: &str) -> bool {
    !(path.starts_with("/internal/") || path == "/health" || path == "/acervo.json")
}

/// `Some(resposta)` quando o pedido não passa no token.
fn denied(state: &Internal, headers: &HeaderMap) -> Option<Response> {
    if state.token.is_empty() {
        let body = json!({ "ok": false, "error": "diagnóstico desativado pelo operador" });
        return Some((StatusCode::SERVICE_UNAVAILABLE, Json(body)).into_response());
    }
    let sent = headers.get(TOKEN_HEADER).and_then(|v| v.to_str().ok());
    if sent != Some(state.token.as_str()) {
        let body = json!({ "ok": false, "error": "token de diagnóstico inválido" });
        return Some((StatusCode::UNAUTHORIZED, Json(body)).into_response());
    }
    None
}

/// `GET /internal/activity?window_ms=` → `{recent}`: houve usuário na janela?
pub async fn activity(
    State(state): State<InternalState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Some(denied) = denied(&state, &headers) {
        return denied;
    }
    let window: i64 = q
        .get("window_ms")
        .and_then(|w| w.parse().ok())
        .unwrap_or(60_000);
    let last = state.last_user_ms.load(Ordering::Relaxed);
    let recent = last > 0 && now_ms() - last < window;
    Json(json!({ "recent": recent })).into_response()
}

/// `POST /internal/crawl-result`: grava a página no acervo. 2xx é terminal para
/// o sidecar; 5xx ele reentrega com backoff.
pub async fn crawl_result(
    State(state): State<InternalState>,
    headers: HeaderMap,
    Json(work): Json<CrawlWorkResult>,
) -> Response {
    if let Some(denied) = denied(&state, &headers) {
        return denied;
    }
    if matches!(
        work.status,
        CrawlResultStatus::Error | CrawlResultStatus::NoWork
    ) {
        eprintln!(
            "[internal-crawl] {} {}: status={:?} (sem gravação)",
            work.site, work.url_key, work.status
        );
        return Json(json!({ "ok": true, "kept": 0, "added": 0, "note": "sem-gravacao" }))
            .into_response();
    }
    match state.acervo.record(&work, now_ms()) {
        Ok((kept, added)) => {
            let note = if work.imdb.is_none() && kept > 0 {
                " (sem IMDb: guardado para identificar)"
            } else {
                ""
            };
            eprintln!(
                "[internal-crawl] {} {}: kept={kept} added={added}{note}",
                work.site, work.url_key
            );
            Json(json!({ "ok": true, "kept": kept, "added": added })).into_response()
        }
        Err(e) => {
            eprintln!(
                "[internal-crawl] {} {}: acervo falhou: {e}",
                work.site, work.url_key
            );
            let body = json!({ "ok": false, "error": "acervo-indisponivel" });
            (StatusCode::INTERNAL_SERVER_ERROR, Json(body)).into_response()
        }
    }
}

/// `GET /acervo.json` (contagem por site) ou `?imdb=tt…` (releases da obra).
pub async fn acervo(
    State(state): State<InternalState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Some(denied) = denied(&state, &headers) {
        return denied;
    }
    let limit = q.get("limit").and_then(|l| l.parse().ok()).unwrap_or(200);
    match state.acervo.query(q.get("imdb").map(String::as_str), limit) {
        Ok(body) => Json(body).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response(),
    }
}
