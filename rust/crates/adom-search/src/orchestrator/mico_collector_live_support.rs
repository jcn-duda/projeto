//! Helpers do servidor falso dos testes do coletor Mico (uma vez só, para a
//! matriz do `live` caber na catraca de 400 linhas).

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;

use super::*;
use crate::orchestrator::live_state::{LiveAllState, LiveBatchState};
use adom_sources::{now_ms, MicoClient, MicoConfig};

pub const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum Mode {
    #[default]
    Ok,
    Empty,
    Irrelevant,
    Http400,
    Http429,
    Http500,
    InvalidJson,
    Hang,
}

#[derive(Clone)]
pub struct Fake {
    mode: Arc<Mutex<Mode>>,
    hits: Arc<AtomicUsize>,
}

impl Fake {
    pub fn set_mode(&self, mode: Mode) {
        *self.mode.lock().expect("mode") = mode;
    }

    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

pub async fn start() -> (String, Fake) {
    let fake = Fake {
        mode: Arc::new(Mutex::new(Mode::Ok)),
        hits: Arc::new(AtomicUsize::new(0)),
    };
    let app: Router<Fake> = Router::new()
        .route("/stream/movie/{id}", get(movie))
        .route("/stream/series/{id}", get(series));
    let app = app.with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), fake)
}

async fn movie(State(fake): State<Fake>, Path(_id): Path<String>) -> Response {
    respond(fake).await
}

async fn series(State(fake): State<Fake>, Path(_id): Path<String>) -> Response {
    respond(fake).await
}

async fn respond(fake: Fake) -> Response {
    fake.hits.fetch_add(1, Ordering::SeqCst);
    // Copia o modo antes do `match`: um `MutexGuard` vivo atravessaria o
    // `.await` do modo Hang e o futuro deixaria de ser `Send` (Handler axum).
    let mode = *fake.mode.lock().expect("mode");
    match mode {
        Mode::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            StatusCode::OK.into_response()
        }
        Mode::Http400 => StatusCode::BAD_REQUEST.into_response(),
        Mode::Http429 => StatusCode::TOO_MANY_REQUESTS.into_response(),
        Mode::Http500 => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Mode::InvalidJson => (StatusCode::OK, "isto não é json").into_response(),
        Mode::Empty => (StatusCode::OK, axum::Json(json!({ "streams": [] }))).into_response(),
        Mode::Irrelevant => (
            StatusCode::OK,
            axum::Json(json!({ "streams": [
                stream("Outro Filme 2001 1080p", HASH_B)
            ] })),
        )
            .into_response(),
        Mode::Ok => (
            StatusCode::OK,
            axum::Json(json!({ "streams": [
                stream("The Matrix 1999 1080p", HASH_A)
            ] })),
        )
            .into_response(),
    }
}

fn stream(title: &str, hash: &str) -> serde_json::Value {
    json!({ "title": title, "infoHash": hash })
}

/// Job da obra (Matrix 1999, filme) com o prazo pedido.
pub fn job_at(deadline_at: i64) -> CollectJob {
    CollectJob {
        encoded: "e30".into(),
        scope: TaskScope::All,
        kind: "movie".into(),
        imdb_id: "tt0133093".into(),
        season: None,
        episode: None,
        year: Some(json!(1999)),
        names: vec!["The Matrix".into()],
        query: "The Matrix 1999".into(),
        pt_query: Some("Matrix 1999".into()),
        sweep_query: Some("Matrix".into()),
        original_query: None,
        multi_work_query: None,
        priority: true,
        deadline_at,
        late_sweep: false,
        providers: Vec::new(),
        jackett_indexers: Vec::new(),
        dubbed_only: false,
        mico_default: true,
    }
}

pub fn config(base: &str, timeout_ms: u64) -> MicoConfig {
    MicoConfig {
        enabled: true,
        url: base.to_string(),
        timeout_ms,
        breaker_failures: 3,
        breaker_cooldown_ms: 5 * 60_000,
        allow_private_url: true,
    }
}

pub fn collector_at(base: &str, timeout_ms: u64) -> MicoCollector {
    let client = MicoClient::new(config(base, timeout_ms)).expect("client");
    MicoCollector::new(client)
}

pub fn live_of(batch: &CollectBatch) -> &LiveBatchState {
    batch.live.as_ref().expect("live")
}

pub fn assert_no_pending_and_unknown_all(live: &LiveBatchState) {
    assert!(live.pending.is_empty(), "timeout do cliente não é pending");
    assert_eq!(
        live.all,
        LiveAllState::Unknown,
        "agregado do Mico é sempre Unknown"
    );
}

pub fn assert_ok(batch: &CollectBatch) {
    let live = live_of(batch);
    assert!(live.failed.is_empty());
    assert!(live.empty.is_empty());
    assert_no_pending_and_unknown_all(live);
}

pub fn assert_empty(batch: &CollectBatch) {
    let live = live_of(batch);
    assert!(live.failed.is_empty());
    assert_eq!(live.empty, BTreeSet::from([MICO_LIVE_KEY.to_string()]));
    assert_no_pending_and_unknown_all(live);
}

pub fn assert_failed(batch: &CollectBatch) {
    assert!(batch.items.is_empty());
    assert!(!batch.partial);
    let live = live_of(batch);
    assert_eq!(live.failed, BTreeSet::from([MICO_LIVE_KEY.to_string()]));
    assert!(live.empty.is_empty());
    assert_no_pending_and_unknown_all(live);
}

pub fn deadline_soon() -> i64 {
    now_ms() + 5_000
}
