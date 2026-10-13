//! Servidor HTTP do sidecar (axum).
//!
//! Expõe endpoints para o painel e o entrypoint:
//! - `GET /health` — healthcheck (sem token)
//! - `GET /status` — status do motor (com token)
//! - `POST /action` — ações de manutenção (com token)
//!
//! # Segurança
//!
//! O servidor escuta APENAS em loopback (127.0.0.1). Endpoints exceto
//! `/health` exigem o header `X-Indexer-Test-Token` com o token unificado.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::motor::{CrawlMotor, SiteStatus};
use crate::store::CrawlStore;

/// Header de autenticação (mesmo que o Node usa).
const TOKEN_HEADER: &str = "X-Indexer-Test-Token";

/// Estado compartilhado entre os handlers do servidor.
pub struct AppState {
    /// Motor de crawl (para status e controle).
    pub motor: Arc<CrawlMotor>,
    /// Store (crawl.db) para ações de manutenção.
    pub store: Arc<Mutex<CrawlStore>>,
    /// Token de autenticação unificado.
    pub auth_token: String,
}

/// Inicia o servidor axum em loopback na porta configurada.
///
/// Retorna quando o servidor é encerrado (erro ou shutdown).
pub async fn run(port: u16, state: Arc<AppState>) {
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/status", get(status_handler))
        .route("/action", post(action_handler))
        .with_state(state);

    let addr = format!("127.0.0.1:{}", port);
    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[sidecar-http] erro ao bindar {}: {}", addr, e);
            return;
        }
    };
    eprintln!("[sidecar-http] escutando em {}", addr);
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[sidecar-http] erro no servidor: {}", e);
    }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/// GET /health — healthcheck para o entrypoint.sh (sem token).
///
/// Responde `200 OK` com body `ok` (text/plain).
async fn health_handler() -> &'static str {
    "ok"
}

/// GET /status — status do motor para o painel (com token).
///
/// Responde JSON com `active`, `sites`, `pages_this_hour`,
/// `global_paused` e `engine`.
async fn status_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> axum::response::Response {
    if let Err(resp) = validate_token(&state.auth_token, &headers) {
        return resp;
    }

    let motor_status = state.motor.status().await;

    /// Resposta do /status (MotorStatus + campo `engine`).
    #[derive(Serialize)]
    struct StatusResponse {
        active: bool,
        sites: Vec<SiteStatus>,
        pages_this_hour: u32,
        global_paused: bool,
        engine: String,
    }

    let resp = StatusResponse {
        active: motor_status.active,
        sites: motor_status.sites,
        pages_this_hour: motor_status.pages_this_hour,
        global_paused: motor_status.global_paused,
        engine: "rust".to_string(),
    };

    (StatusCode::OK, Json(resp)).into_response()
}

/// Corpo da requisição POST /action.
#[derive(Deserialize)]
struct ActionRequest {
    /// Nome da ação (`crawl-reprocess-errors`, `crawl-reset`).
    action: String,
    /// Confirmação para ações destrutivas.
    #[serde(default)]
    confirm: bool,
    /// Site alvo (string vazia = global).
    #[serde(default)]
    site: String,
}

/// Resposta padrão das ações.
#[derive(Serialize)]
struct ActionResponse {
    ok: bool,
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    site: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    requeued: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    urls: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// POST /action — ações de manutenção (com token).
///
/// Ações suportadas:
/// - `crawl-reprocess-errors`: reenfileira URLs com erro do site
/// - `crawl-reset`: apaga todas as URLs do site (exige `confirm: true`)
async fn action_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<ActionRequest>,
) -> axum::response::Response {
    if let Err(resp) = validate_token(&state.auth_token, &headers) {
        return resp;
    }

    let action = body.action.as_str();
    let site = body.site.trim().to_string();

    match action {
        "crawl-reprocess-errors" => handle_reprocess_errors(&state, &site).await,
        "crawl-reset" => {
            if !body.confirm {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(ActionResponse {
                        ok: false,
                        action: action.to_string(),
                        site: Some(site),
                        requeued: None,
                        urls: None,
                        error: Some("confirm obrigatório".to_string()),
                    }),
                )
                    .into_response();
            }
            handle_reset(&state, &site).await
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(ActionResponse {
                ok: false,
                action: action.to_string(),
                site: Some(site),
                requeued: None,
                urls: None,
                error: Some(format!("ação desconhecida: {}", action)),
            }),
        )
            .into_response(),
    }
}

// ─── Handlers de ações ───────────────────────────────────────────────────────

/// Processa `crawl-reprocess-errors`: reenfileira URLs com erro.
async fn handle_reprocess_errors(state: &AppState, site: &str) -> axum::response::Response {
    let store = state.store.lock().await;
    match store.requeue_errors(site) {
        Ok(requeued) => (
            StatusCode::OK,
            Json(ActionResponse {
                ok: true,
                action: "crawl-reprocess-errors".to_string(),
                site: Some(site.to_string()),
                requeued: Some(requeued),
                urls: None,
                error: None,
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ActionResponse {
                ok: false,
                action: "crawl-reprocess-errors".to_string(),
                site: Some(site.to_string()),
                requeued: None,
                urls: None,
                error: Some(e.to_string()),
            }),
        )
            .into_response(),
    }
}

/// Processa `crawl-reset`: apaga todas as URLs do site.
async fn handle_reset(state: &AppState, site: &str) -> axum::response::Response {
    let store = state.store.lock().await;

    // Conta URLs antes de apagar (para o campo `urls` na resposta).
    let url_count = match store.counters(site) {
        Ok(c) => c.pending + c.done + c.no_torrent + c.no_work + c.error + c.inflight + c.simulated,
        Err(_) => 0,
    };

    match store.clear_site(site) {
        Ok(()) => (
            StatusCode::OK,
            Json(ActionResponse {
                ok: true,
                action: "crawl-reset".to_string(),
                site: Some(site.to_string()),
                requeued: None,
                urls: Some(url_count),
                error: None,
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ActionResponse {
                ok: false,
                action: "crawl-reset".to_string(),
                site: Some(site.to_string()),
                requeued: None,
                urls: None,
                error: Some(e.to_string()),
            }),
        )
            .into_response(),
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Valida o header `X-Indexer-Test-Token`.
///
/// Retorna `Err(response)` com 401 se o token estiver inválido.
/// Se o token esperado estiver vazio, permite (modo dev).
#[allow(clippy::result_large_err)] // Response contém Body; é o contrato do axum handler
fn validate_token(expected: &str, headers: &HeaderMap) -> Result<(), axum::response::Response> {
    if expected.is_empty() {
        // Token não configurado — permite (modo dev).
        return Ok(());
    }
    let got = headers
        .get(TOKEN_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if got != expected {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "ok": false, "error": "token inválido" })),
        )
            .into_response());
    }
    Ok(())
}
