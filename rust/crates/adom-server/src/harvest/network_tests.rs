//! `NetworkDrain` real contra metadados/Jackett/BLUDV locais. Zero rede real.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

use adom_harvest::{
    EnqueueReason, HarvestQueue, HarvestQueueConfig, HarvestRequest, HarvestStore, HarvestWorker,
    HarvestWorkerConfig,
};
use adom_search::orchestrator::SharedIndex;
use adom_sources::{
    BludvClient, BludvConfig, CinemetaConfig, JackettClient, JackettConfig, MetaSources,
    SourcesConfig, TmdbConfig,
};
use adom_store::{streams_prefix, NativeReleaseIndex, ReleaseIndexStore, StreamsStore};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::json;

use super::NetworkDrain;
use crate::harvest::config::HarvestConfig;
use crate::harvest::enqueue::enqueue_with_dedupe;
use crate::harvest::evidence::EvidenceSnapshot;
use crate::harvest::serve::{run_iteration, IterationOutcome};
use crate::harvest::settle::Settler;
use crate::harvest::status::HarvestStatus;
use crate::harvest::traffic::StreamTraffic;
use crate::harvest::Inner;

const NOW: i64 = 1_700_000_000_000;
const IMDB: &str = "tt7286456";
const OTHER: &str = "tt0068646";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TITLE: &str = "Coringa 2019 1080p Dublado";

#[derive(Clone)]
struct FakeNet {
    inner: Arc<NetInner>,
}

struct NetInner {
    jackett: Mutex<Vec<String>>,
    bludv: Mutex<Vec<String>>,
    fail: Mutex<HashSet<String>>,
    base: Mutex<String>,
}

#[derive(Deserialize)]
struct SearchQ {
    s: Option<String>,
}

impl FakeNet {
    async fn start() -> (Self, String) {
        let api = Self {
            inner: Arc::new(NetInner {
                jackett: Mutex::new(Vec::new()),
                bludv: Mutex::new(Vec::new()),
                fail: Mutex::new(HashSet::new()),
                base: Mutex::new(String::new()),
            }),
        };
        let app = Router::new()
            .route("/meta/movie/{id}", get(cinemeta))
            .route("/api/v2.0/indexers/{indexer}/results", get(jackett))
            .route("/", get(bludv_search))
            .route("/filme/{slug}", get(bludv_post))
            .route("/systemads/{id}", get(protector))
            .with_state(api.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let base = format!("http://{addr}");
        *api.inner.base.lock().expect("base") = base.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (api, base)
    }

    fn fail(&self, indexer: &str) {
        self.inner.fail.lock().expect("fail").insert(indexer.into());
    }

    fn jackett(&self) -> Vec<String> {
        self.inner.jackett.lock().expect("j").clone()
    }

    fn bludv(&self) -> Vec<String> {
        self.inner.bludv.lock().expect("b").clone()
    }
}

async fn cinemeta(Path(id): Path<String>) -> Response {
    let imdb = id.trim_end_matches(".json");
    (
        StatusCode::OK,
        axum::Json(json!({
            "meta": { "id": imdb, "name": "Coringa", "year": "2019", "type": "movie" }
        })),
    )
        .into_response()
}

async fn jackett(
    State(api): State<FakeNet>,
    Path(indexer): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let _ = q;
    api.inner.jackett.lock().expect("j").push(indexer.clone());
    if api.inner.fail.lock().expect("fail").contains(&indexer) {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (
        StatusCode::OK,
        axum::Json(json!({
            "Results": [{
                "Title": TITLE,
                "MagnetUri": format!("magnet:?xt=urn:btih:{HASH}"),
                "InfoHash": HASH,
                "Seeders": 5,
                "Size": 1234,
                "Tracker": indexer,
                "TrackerId": indexer,
            }],
            "Indexers": [{ "Status": 2, "Error": null }]
        })),
    )
        .into_response()
}

async fn bludv_search(State(api): State<FakeNet>, Query(q): Query<SearchQ>) -> Response {
    api.inner
        .bludv
        .lock()
        .expect("b")
        .push(format!("/?s={}", q.s.as_deref().unwrap_or("")));
    let base = api.inner.base.lock().expect("base").clone();
    Html(format!(
        r#"<div class="post"><div class="title">
          <a href="{base}/filme/coringa">Coringa (2019)</a>
        </div></div>"#
    ))
    .into_response()
}

async fn bludv_post(State(api): State<FakeNet>, Path(slug): Path<String>) -> Response {
    api.inner
        .bludv
        .lock()
        .expect("b")
        .push(format!("/filme/{slug}"));
    let base = api.inner.base.lock().expect("base").clone();
    Html(format!(
        r#"VERSÃO MKV DUAL ÁUDIO WEB-DL 1080p (3.39 GB - MKV)
        <a href="{base}/systemads/a">DL</a>"#
    ))
    .into_response()
}

async fn protector(State(api): State<FakeNet>, Path(id): Path<String>) -> Response {
    api.inner.bludv.lock().expect("b").push(format!("/p/{id}"));
    Html(format!(
        r#"<a href="magnet:?xt=urn:btih:{HASH}&amp;dn=x">x</a>"#
    ))
    .into_response()
}

fn sources(base: &str) -> SourcesConfig {
    SourcesConfig {
        user_agent: "adom-harvest-net/1.0".into(),
        cinemeta: CinemetaConfig {
            base_url: base.into(),
            request_timeout_ms: 1_500,
            ..CinemetaConfig::default()
        },
        tmdb: TmdbConfig {
            api_key: String::new(),
            request_timeout_ms: 1_500,
            ..TmdbConfig::default()
        },
    }
}

fn jackett_cfg(base: &str) -> JackettConfig {
    JackettConfig {
        url: base.trim_end_matches('/').into(),
        api_key: "k".into(),
        indexers: vec!["yts".into(), "rede".into()],
        pt_br_indexers: vec!["rede".into()],
        breaker_enabled: false,
        indexer_timeout_ms: 1_500,
        br_indexer_timeout_ms: 1_500,
        ..JackettConfig::default()
    }
}

fn bludv(base: &str) -> BludvClient {
    BludvClient::new(BludvConfig {
        enabled: true,
        base_url: base.trim_end_matches('/').into(),
        timeout_ms: 1_500,
        allow_private_url: true,
        ..BludvConfig::default()
    })
    .expect("bludv")
}

fn put_stream(store: &StreamsStore, imdb: &str) {
    let key = format!("{}movie:{imdb}:{{\"m\":1}}:account:a", streams_prefix());
    let entry = adom_search::StreamsEntry {
        streams: vec![adom_search::StreamItem {
            info_hash: Some(HASH.into()),
            ..adom_search::StreamItem::default()
        }],
        partial: false,
        debrid_known: Some(true),
        ..Default::default()
    };
    store.set(&key, &entry, 600, 1_000).unwrap();
}

fn stream_key(imdb: &str) -> String {
    format!("{}movie:{imdb}:{{\"m\":1}}:account:a", streams_prefix())
}

struct Harness {
    inner: Arc<Inner>,
    drain: NetworkDrain,
    index: SharedIndex,
    streams: Arc<StreamsStore>,
}

impl Harness {
    fn new(base: &str, bludv_on: bool, streams: Arc<StreamsStore>) -> Self {
        let index: SharedIndex = Arc::new(NativeReleaseIndex::from_store(
            ReleaseIndexStore::open_memory().expect("idx"),
        ));
        let drain = NetworkDrain::for_test(
            MetaSources::with_memory_store(sources(base)).expect("meta"),
            JackettClient::new(jackett_cfg(base)).expect("jackett"),
            jackett_cfg(base),
            index.clone(),
            Some(streams.clone()),
            bludv_on.then(|| bludv(base)),
            vec!["yts".into(), "rede".into()],
            vec!["rede".into()],
            0,
        );
        let store = Arc::new(HarvestStore::open_memory().unwrap());
        let config = HarvestConfig::default();
        let inner = Arc::new(Inner {
            env: config.clone(),
            config: Mutex::new(config),
            live_dirty: AtomicBool::new(false),
            store,
            store_path: PathBuf::from("harvest-net"),
            queue: tokio::sync::Mutex::new(HarvestQueue::new(HarvestQueueConfig::default())),
            status: Mutex::new(HarvestStatus::default()),
            paused: AtomicBool::new(false),
            traffic: StreamTraffic::new(Arc::new(std::sync::atomic::AtomicI64::new(0)), 0),
            notify: tokio::sync::Notify::new(),
            preempt: tokio::sync::Notify::new(),
            inflight_rank: Mutex::new(None),
            drain_budget: AtomicUsize::new(0),
            drain_reply: Mutex::new(None),
            index: Some(index.clone()),
            evidence: Mutex::new(EvidenceSnapshot::default()),
        });
        Self {
            inner,
            drain,
            index,
            streams,
        }
    }

    async fn enqueue(&self, req: HarvestRequest) -> EnqueueReason {
        let mut queue = self.inner.queue.lock().await;
        enqueue_with_dedupe(&mut queue, &self.inner.store, req, NOW, None, None).reason
    }

    async fn tick(&mut self, req: HarvestRequest) -> IterationOutcome {
        assert_eq!(self.enqueue(req).await, EnqueueReason::Queued);
        let mut worker = HarvestWorker::new(HarvestWorkerConfig {
            enabled: true,
            max_per_hour: 1_000,
        });
        let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
        run_iteration(&self.inner, &mut worker, &mut self.drain, &mut settler, NOW).await
    }
}

fn probe() -> HarvestRequest {
    let mut req = HarvestRequest::movie(IMDB, "br-gap");
    req.br_probe = true;
    req
}

#[tokio::test]
async fn full_grava_indice_invalida_obra_e_consulta_bludv() {
    let (api, base) = FakeNet::start().await;
    let streams = Arc::new(StreamsStore::open_memory().unwrap());
    put_stream(&streams, IMDB);
    put_stream(&streams, OTHER);
    let mut h = Harness::new(&base, true, streams.clone());
    assert_eq!(
        h.tick(HarvestRequest::movie(IMDB, "miss")).await,
        IterationOutcome::Drained { ok: true }
    );
    assert_eq!(api.jackett(), vec!["yts".to_string(), "rede".to_string()]);
    assert!(!api.bludv().is_empty(), "FULL consulta BLUDV");
    assert!(!h.index.is_partial(IMDB, None, None, NOW));
    assert!(!h.index.lookup(IMDB, None, None, NOW).is_empty());
    assert!(h.streams.get(&stream_key(IMDB), 2_000).unwrap().is_none());
    assert!(h.streams.get(&stream_key(OTHER), 2_000).unwrap().is_some());
}

#[tokio::test]
async fn sonda_nao_chama_bludv_nem_certifica() {
    let (api, base) = FakeNet::start().await;
    let mut h = Harness::new(&base, true, Arc::new(StreamsStore::open_memory().unwrap()));
    assert_eq!(
        h.tick(probe()).await,
        IterationOutcome::Drained { ok: true }
    );
    assert_eq!(api.jackett(), vec!["rede".to_string()]);
    assert!(api.bludv().is_empty(), "sonda não fala com BLUDV");
    assert!(h.index.is_partial(IMDB, None, None, NOW));
}

#[tokio::test]
async fn full_incompleta_fica_parcial_e_falha_total_reinsere() {
    let (api, base) = FakeNet::start().await;
    api.fail("yts");
    let mut h = Harness::new(&base, false, Arc::new(StreamsStore::open_memory().unwrap()));
    assert_eq!(
        h.tick(HarvestRequest::movie(IMDB, "miss")).await,
        IterationOutcome::Drained { ok: true }
    );
    assert!(h.index.is_partial(IMDB, None, None, NOW));
    assert!(!h.index.lookup(IMDB, None, None, NOW).is_empty());

    let (api, base) = FakeNet::start().await;
    api.fail("yts");
    api.fail("rede");
    let mut h = Harness::new(&base, false, Arc::new(StreamsStore::open_memory().unwrap()));
    assert_eq!(
        h.tick(HarvestRequest::movie(IMDB, "miss")).await,
        IterationOutcome::Drained { ok: false }
    );
    let queue = h.inner.queue.lock().await;
    let rem = queue.find_queued(IMDB, None, None).expect("retry FULL");
    assert!(!rem.br_probe);
    assert_eq!(rem.reason, "miss");
}
