//! Helpers compartilhados pelos testes do coletor Torrentio (servidor falso,
//! config e asserções do `live`). Incluído UMA vez pelo módulo pai, para os
//! arquivos de teste de identidade, matriz do `live` e breaker não duplicarem
//! o fake HTTP.

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
use crate::orchestrator::live_state::LiveAllState;
use adom_sources::TorrentioConfig;

pub const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Job base da obra (Matrix 1999, filme).
pub fn base_job() -> CollectJob {
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
        priority: false,
        deadline_at: 1_700_000_000_000,
        late_sweep: false,
        providers: Vec::new(),
        jackett_indexers: Vec::new(),
        dubbed_only: false,
        mico_default: false,
    }
}

/// Comportamento do pool falso.
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
pub struct FakeState {
    mode: Arc<Mutex<Mode>>,
    hits: Arc<AtomicUsize>,
}

impl FakeState {
    pub fn set_mode(&self, mode: Mode) {
        *self.mode.lock().expect("mode") = mode;
    }

    pub fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

pub async fn start(mode: Mode) -> (String, FakeState) {
    let state = FakeState {
        mode: Arc::new(Mutex::new(mode)),
        hits: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route("/stream/movie/{id}", get(movie))
        .route("/stream/series/{id}", get(series))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), state)
}

async fn movie(State(state): State<FakeState>, Path(_id): Path<String>) -> Response {
    respond(state).await
}

async fn series(State(state): State<FakeState>, Path(_id): Path<String>) -> Response {
    respond(state).await
}

async fn respond(state: FakeState) -> Response {
    state.hits.fetch_add(1, Ordering::SeqCst);
    let mode = *state.mode.lock().expect("mode");
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
                stream("Outro Filme 2001 1080p", HASH_B, None)
            ] })),
        )
            .into_response(),
        Mode::Ok => (
            StatusCode::OK,
            axum::Json(json!({ "streams": [
                stream("The Matrix 1999 1080p", HASH_A, Some(1))
            ] })),
        )
            .into_response(),
    }
}

fn stream(title: &str, hash: &str, file_idx: Option<i64>) -> serde_json::Value {
    let mut value = json!({ "title": title, "infoHash": hash });
    if let Some(idx) = file_idx {
        value["fileIdx"] = json!(idx);
    }
    value
}

pub fn config(base: &str, timeout_ms: u64) -> TorrentioConfig {
    TorrentioConfig {
        enabled: true,
        url: base.to_string(),
        timeout_ms,
        breaker_failures: 3,
        breaker_cooldown_ms: 5 * 60_000,
        allow_private_url: true,
        ..TorrentioConfig::default()
    }
}

pub fn collector_at(base: &str, timeout_ms: u64) -> TorrentioCollector {
    let client = TorrentioClient::new(config(base, timeout_ms)).expect("client");
    TorrentioCollector::new(client)
}

pub async fn collect_at(base: &str, timeout_ms: u64) -> CollectBatch {
    collector_at(base, timeout_ms)
        .collect(base_job())
        .await
        .expect("coleta")
}

pub fn assert_no_pending_and_unknown_all(live: &LiveBatchState) {
    assert!(live.pending.is_empty(), "nunca inventa pending");
    assert_eq!(
        live.all,
        LiveAllState::Unknown,
        "all é só do ramo /all do Jackett"
    );
}

pub fn assert_failed(batch: &CollectBatch) {
    assert!(batch.items.is_empty());
    assert!(!batch.partial);
    let live = batch.live.as_ref().expect("live");
    assert_eq!(
        live.failed,
        BTreeSet::from([TORRENTIO_LIVE_KEY.to_string()])
    );
    assert!(live.empty.is_empty());
    assert_no_pending_and_unknown_all(live);
}

pub fn assert_empty(batch: &CollectBatch) {
    let live = batch.live.as_ref().expect("live");
    assert!(live.failed.is_empty());
    assert_eq!(live.empty, BTreeSet::from([TORRENTIO_LIVE_KEY.to_string()]));
    assert_no_pending_and_unknown_all(live);
}
