//! Contrato HTTP da sonda RD: addMagnet, poll, inventário e remoção.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use super::*;

#[derive(Default)]
struct FakeRd {
    deletes: AtomicUsize,
}

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

fn magnet_hash(body: &str) -> String {
    [HASH_READY, HASH_DOWN]
        .into_iter()
        .find(|hash| body.contains(hash))
        .map(str::to_string)
        .unwrap_or_default()
}

async fn add_magnet(body: String) -> Response {
    match magnet_hash(&body).as_str() {
        HASH_READY => Json(json!({ "id": "101" })).into_response(),
        HASH_DOWN => Json(json!({ "id": "202" })).into_response(),
        _ => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "boom" })),
        )
            .into_response(),
    }
}

async fn torrent_info(Path(id): Path<String>) -> Json<Value> {
    let status = if id == "101" {
        "downloaded"
    } else {
        "downloading"
    };
    Json(json!({ "id": id, "status": status, "files": [] }))
}

async fn list_torrents() -> Json<Value> {
    Json(json!([
        { "id": 101, "hash": HASH_READY, "status": "downloaded" },
        { "id": 202, "hash": HASH_DOWN, "status": "downloading" },
    ]))
}

async fn remove_torrent(State(state): State<Arc<FakeRd>>) -> axum::http::StatusCode {
    state.deletes.fetch_add(1, Ordering::SeqCst);
    axum::http::StatusCode::NO_CONTENT
}

fn app(state: Arc<FakeRd>) -> Router {
    Router::new()
        .route("/torrents/addMagnet", post(add_magnet))
        .route("/torrents/info/{id}", get(torrent_info))
        .route("/torrents/delete/{id}", delete(remove_torrent))
        .route("/torrents", get(list_torrents))
        .with_state(state)
}

// O cadeado protege `REALDEBRID_API_BASE` através dos awaits do teste.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn sonda_http_classifica_ready_e_isola_erro() {
    use adom_debrid::rd_scheduler::RdSchedulerConfig;
    use adom_debrid::realdebrid::RealDebrid;
    use adom_debrid::HttpClient;

    let _guard = env_lock();
    let state = Arc::new(FakeRd::default());
    let shared = state.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app(state)).await;
    });
    std::env::set_var("REALDEBRID_API_BASE", format!("http://{addr}"));
    let rd = Arc::new(RealDebrid::new(HttpClient::new().unwrap()));
    let gate = super::super::rd::GateWarm::with_gate(
        rd,
        RdSchedulerConfig {
            min_gap_ms: 0.0,
            max_gap_ms: 0.0,
            cooldown_ms: 0.0,
            play_max_wait_ms: 0.0,
            success_threshold: 5,
            enabled: false,
        },
        Duration::from_millis(1),
    );
    let hashes = vec![
        HASH_ERR.to_string(),
        HASH_READY.to_string(),
        HASH_DOWN.to_string(),
    ];
    let report = gate.warm("chave-de-teste", &hashes).await;
    std::env::remove_var("REALDEBRID_API_BASE");
    server.abort();

    assert!(!report.stopped, "erro de um hash não é cooldown");
    assert!(report
        .signals
        .contains(&(HASH_READY.to_string(), WarmSignal::Hit)));
    assert!(report
        .signals
        .contains(&(HASH_DOWN.to_string(), WarmSignal::Miss)));
    assert!(!report.signals.iter().any(|(hash, _)| hash == HASH_ERR));
    assert_eq!(shared.deletes.load(Ordering::SeqCst), 1, "limpou o magnet");
}
