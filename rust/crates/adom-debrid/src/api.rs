//! API interna em `127.0.0.1:8710`. O token vai só no header
//! `X-Indexer-Test-Token`. A chave do debrid chega no corpo e não é logada.
//! premiumize, debridlink e realdebrid respondem nas rotas que o adaptador
//! já tem. torbox e alldebrid seguem 501. O check do Real-Debrid também:
//! o POST não traz o peek, e esta API não lê o ledger `rdc`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::http::HttpClient;
use crate::import::{self, ImportReport};
use crate::metrics::Metrics;
use crate::store::Store;

#[path = "api_dispatch.rs"]
mod dispatch;

pub struct InternalConfig {
    pub listen: SocketAddr,
    pub token: String,
    pub debrid_db: PathBuf,
    pub cache_db: PathBuf,
    pub import: bool,
}

struct AppState {
    token: String,
    metrics: Metrics,
    #[allow(dead_code)]
    store: Option<Store>,
    http: Option<HttpClient>,
}

pub fn parse_listen(listen: &str) -> Result<SocketAddr, String> {
    let addr: SocketAddr = listen
        .parse()
        .map_err(|_| format!("DEBRID_INTERNAL_LISTEN invalido: {listen}"))?;
    if !addr.ip().is_loopback() {
        return Err(format!("API interna só escuta em loopback: {listen}"));
    }
    Ok(addr)
}

pub fn config_from_env() -> Result<InternalConfig, String> {
    let listen =
        std::env::var("DEBRID_INTERNAL_LISTEN").unwrap_or_else(|_| "127.0.0.1:8710".into());
    let mut token = std::env::var("DEBRID_INTERNAL_TOKEN").unwrap_or_default();
    if token.is_empty() {
        token = std::env::var("JACKETT_TEST_TOKEN").unwrap_or_default();
    }
    let import = std::env::var("DEBRID_RUST_IMPORT").unwrap_or_default() == "on";
    Ok(InternalConfig {
        listen: parse_listen(&listen)?,
        token,
        debrid_db: std::env::var("DEBRID_DB_PATH")
            .unwrap_or_else(|_| "data/debrid.db".into())
            .into(),
        cache_db: std::env::var("CACHE_DB_PATH")
            .unwrap_or_else(|_| "data/cache.db".into())
            .into(),
        import,
    })
}

pub fn router(cfg: &InternalConfig) -> Router {
    let store = match Store::open(&cfg.debrid_db) {
        Ok(store) => {
            if cfg.import {
                log_import(import::import_once(&cfg.debrid_db, &cfg.cache_db));
            }
            Some(store)
        }
        Err(err) => {
            eprintln!("[debrid] debrid.db indisponivel: {err}");
            None
        }
    };
    if cfg.token.is_empty() {
        eprintln!("[debrid] sem token; API interna responde 503");
    }
    // Falha de `new` não carrega chave: o cliente ainda não viu o corpo.
    let http = match HttpClient::new() {
        Ok(client) => Some(client),
        Err(_) => {
            eprintln!("[debrid] cliente http indisponivel");
            None
        }
    };
    let state = Arc::new(AppState {
        token: cfg.token.clone(),
        metrics: Metrics::new(),
        store,
        http,
    });
    Router::new()
        .route("/metrics", get(metrics))
        .route("/debrid/check", post(dispatch::check))
        .route("/debrid/link", post(dispatch::link))
        .route("/debrid/account", post(dispatch::account))
        .route("/debrid/files", post(dispatch::files))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state)
}

pub async fn serve(cfg: InternalConfig) -> Result<(), String> {
    let listen = cfg.listen;
    let app = router(&cfg);
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|err| format!("nao escutei {listen}: {err}"))?;
    let bound = listener
        .local_addr()
        .map_err(|err| format!("endereco local: {err}"))?;
    eprintln!("[debrid] API interna em {bound}");
    axum::serve(listener, app)
        .await
        .map_err(|err| format!("API interna encerrou: {err}"))
}

fn log_import(result: Result<ImportReport, String>) {
    match result {
        Ok(report) if report.already => eprintln!("[debrid] import já feito"),
        Ok(report) => eprintln!("[debrid] import copiou {}", report.copied),
        Err(err) => eprintln!("[debrid] import falhou: {err}"),
    }
}

async fn auth(
    State(state): State<Arc<AppState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if state.token.is_empty() {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json_disabled())).into_response();
    }
    let got = req
        .headers()
        .get("x-indexer-test-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !tokens_match(&state.token, &got) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    next.run(req).await
}

fn json_disabled() -> Value {
    serde_json::json!({ "error": "debrid_internal_disabled" })
}

fn tokens_match(expected: &str, got: &str) -> bool {
    let left = Sha256::digest(expected.as_bytes());
    let right = Sha256::digest(got.as_bytes());
    bool::from(left.as_slice().ct_eq(right.as_slice()))
}

async fn metrics(State(state): State<Arc<AppState>>) -> Json<serde_json::Map<String, Value>> {
    let mut map = serde_json::Map::new();
    for (key, value) in state.metrics.snapshot() {
        map.insert(key, Value::from(value));
    }
    Json(map)
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod api_tests;
