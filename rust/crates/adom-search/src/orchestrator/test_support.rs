//! Testes do orquestrador: SWR, coalescing, corte de prazo, HMAC, aviso,
//! host só na resposta e trace serializado.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::{RankingStream, StreamDisplayConfig};
use serde_json::{json, Value};

pub use crate::cache::MemorySwrStore;
pub use crate::collection_window::CollectBudgets;
pub use crate::internal_types::*;
pub use crate::list_builder::{BuildOptions, DebridAnswer, DebridCheck};
pub use crate::orchestrator::*;
pub use crate::raw_item::RawItem;

pub const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
pub const ORIGIN: &str = "http://127.0.0.1:7000";
pub const SEGMENT: &str = "e30";

// ── Stubs ───────────────────────────────────────────────────────────────────

pub struct StubCollector {
    batches: Mutex<Vec<CollectBatch>>,
    always: Option<CollectBatch>,
    calls: AtomicUsize,
    delay: Duration,
    fail: bool,
}

impl StubCollector {
    pub fn with(items: Vec<RawItem>) -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(vec![CollectBatch {
                items,
                partial: false,
                live: None,
            }]),
            always: None,
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: false,
        })
    }

    pub fn with_always(items: Vec<RawItem>) -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(Vec::new()),
            always: Some(CollectBatch {
                items,
                partial: false,
                live: None,
            }),
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: false,
        })
    }

    pub fn empty() -> Arc<Self> {
        Self::with(Vec::new())
    }

    /// Balde vazio mas coleta ainda aberta (`partial:true`) — o Node devolve
    /// isto quando a janela corta e o completion segue em fundo.
    pub fn empty_partial() -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(vec![CollectBatch {
                items: Vec::new(),
                partial: true,
                live: None,
            }]),
            always: None,
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: false,
        })
    }

    pub fn failing() -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(Vec::new()),
            always: None,
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: true,
        })
    }

    pub fn slow(items: Vec<RawItem>, delay: Duration) -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(vec![CollectBatch {
                items,
                partial: false,
                live: None,
            }]),
            always: None,
            calls: AtomicUsize::new(0),
            delay,
            fail: false,
        })
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl Collector for StubCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            if self.fail {
                return Err("coletor fora do ar".into());
            }
            if let Some(always) = &self.always {
                return Ok(always.clone());
            }
            let mut guard = self.batches.lock().expect("batches");
            if guard.is_empty() {
                Ok(CollectBatch::default())
            } else {
                Ok(guard.remove(0))
            }
        })
    }
}

pub struct StubMeta(pub SearchMeta);

impl MetaSource for StubMeta {
    fn resolve<'a>(&'a self, _req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
}

/// Meta + collect que gravam o `encoded` recebido (prova do path sem config).
#[derive(Default)]
pub struct RecordingBackend {
    pub meta_encoded: Mutex<Vec<String>>,
    pub collect_encoded: Mutex<Vec<String>>,
}

impl MetaSource for RecordingBackend {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move {
            self.meta_encoded
                .lock()
                .expect("meta_encoded")
                .push(req.encoded.clone());
            Ok(meta())
        })
    }
}

impl Collector for RecordingBackend {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.collect_encoded
                .lock()
                .expect("collect_encoded")
                .push(job.encoded.clone());
            Ok(CollectBatch {
                items: vec![item(HASH)],
                partial: false,
                live: None,
            })
        })
    }
}

pub struct StubCheck {
    cached: Vec<String>,
}

impl DebridCheck for StubCheck {
    fn check(&mut self, stream: &RankingStream) -> DebridAnswer {
        let hash = stream.info_hash.clone().unwrap_or_default();
        if self.cached.contains(&hash) {
            DebridAnswer::Cached { url: None }
        } else {
            DebridAnswer::Missing
        }
    }
}

pub struct StubDebrid {
    pub cached: Vec<String>,
}

impl DebridFactory for StubDebrid {
    fn make(&self, _ctx: &DebridContext) -> Box<dyn DebridCheck + Send> {
        Box::new(StubCheck {
            cached: self.cached.clone(),
        })
    }
}

#[derive(Default)]
pub struct RecordingTail {
    index: Mutex<Vec<IndexBatch>>,
    effects: Mutex<Vec<EffectsBatch>>,
}

impl RecordingTail {
    pub fn index_writes(&self) -> Vec<IndexBatch> {
        self.index.lock().expect("index").clone()
    }

    pub fn effects_batches(&self) -> Vec<EffectsBatch> {
        self.effects.lock().expect("effects").clone()
    }
}

impl TailEffects for RecordingTail {
    fn index_write<'a>(
        &'a self,
        batch: IndexBatch,
    ) -> RouteFuture<'a, crate::internal_types::IndexWriteResponse> {
        Box::pin(async move {
            self.index.lock().expect("index").push(batch);
            Ok(crate::internal_types::IndexWriteResponse {
                ok: true,
                recorded: 1,
                entries: 1,
                bank_marked: 0,
                failed: 0,
            })
        })
    }

    fn effects<'a>(
        &'a self,
        batch: EffectsBatch,
    ) -> RouteFuture<'a, crate::internal_types::EffectsResponse> {
        Box::pin(async move {
            let accepted = batch.effects.len() as i64;
            self.effects.lock().expect("effects").push(batch);
            Ok(crate::internal_types::EffectsResponse {
                ok: true,
                accepted,
                rejected: 0,
            })
        })
    }
}

// ── Cenário ─────────────────────────────────────────────────────────────────

pub fn options() -> Value {
    json!({
        "providers": ["jackett"],
        "qualities": [],
        "maxResults": 40,
        "minSeeders": 0,
        "brReservedSlots": 0,
        "brFirst": true,
        "jackettIndexers": [],
        "indexerPriority": [],
        "indexerLimits": {},
        "brOnly": false,
        "dubbedOnly": false,
        "preferDubbed": false,
        "excludeCam": false,
        "maxSizeGb": 0,
        "maxPerIndexer": 0,
        "debridService": "alldebrid",
        "debridApiKey": "chave-teste",
        "debridCachedOnly": false,
        "showUncachedBr": true,
        "autoFetchBr": false,
        "streamNameStyle": "compact",
        "streamNameShowSource": true,
    })
}

pub fn config() -> OrchestratorConfig {
    OrchestratorConfig {
        budgets: CollectBudgets {
            reply_deadline_ms: 5000,
            debrid_reserve_ms: 100,
            debrid_check_floor_ms: 50,
            br_partial_grace_ms: 0,
            br_total_ms: 1000,
        },
        stremio_reply_ms: 5000,
        app_reply_ms: 5000,
        cache_ttl: 900,
        fallback_streams_ttl: 120,
        stale_grace_seconds: 300,
        defaults: options(),
        resolve_secret: String::new(),
        resolve_uncached: false,
        build: BuildOptions::default(),
        display: StreamDisplayConfig::default(),
        selected_indexers: Vec::new(),
        pt_br_indexers: Vec::new(),
        isolate_indexers: Vec::new(),
        index_only_indexers: Vec::new(),
        sweep_enabled: false,
        trace_enabled: true,
        search_index_rescue_min_ms: 2500,
        tail_collect_ms: 25_000,
        pack_tail: true,
        effects_enabled: false,
        mico_default: false,
    }
}

pub fn meta() -> SearchMeta {
    SearchMeta {
        imdb_id: "tt0133093".into(),
        season: None,
        episode: None,
        name: "Filme Teste".into(),
        names: vec!["Filme Teste".into()],
        year: json!("2024"),
        alt_year: None,
        query: "Filme Teste 2024".into(),
        pt_query: None,
        pt_title: None,
        titles: None,
        sweep_query: None,
        original_query: None,
        multi_work_root: None,
        multi_work_query: None,
        episode_counts: Vec::new(),
        is_demo: false,
    }
}

pub fn item(hash: &str) -> RawItem {
    RawItem {
        title: Some("Filme Teste 2024 1080p WEB-DL x264".into()),
        info_hash: Some(hash.into()),
        seeders: Some(20.0),
        indexer: Some("bludv".into()),
        ..RawItem::default()
    }
}

pub fn request(now: i64) -> StreamRequest {
    StreamRequest {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        user_agent: Some("Stremio/1.6".into()),
        origin: Some(ORIGIN.into()),
        now_ms: Some(now),
    }
}

pub fn orchestrator(
    config: OrchestratorConfig,
    store: Arc<MemorySwrStore>,
    collector: Arc<StubCollector>,
    debrid_cached: &[&str],
) -> Orchestrator {
    Orchestrator::new(config, store)
        .with_collector(collector)
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: debrid_cached.iter().map(|h| h.to_string()).collect(),
        }))
}

pub fn entry_key(orch: &Orchestrator) -> String {
    let options = orch.resolve_options(&Some(SEGMENT.into()));
    request_cache_key("movie", "tt0133093", &orch.key_options(&options))
}

pub fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&text[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}
