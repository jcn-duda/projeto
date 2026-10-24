//! Testes do orquestrador: SWR, coalescing, corte de prazo, HMAC, aviso,
//! host só na resposta e trace serializado.

use std::sync::Arc;

use adom_core::StreamDisplayConfig;
use serde_json::{json, Value};

pub use crate::cache::MemorySwrStore;
pub use crate::collection_window::CollectBudgets;
pub use crate::internal_types::*;
pub use crate::list_builder::{BuildOptions, DebridAnswer, DebridCheck};
pub use crate::orchestrator::*;
pub use crate::raw_item::RawItem;

#[path = "test_support/stubs.rs"]
mod stubs;
pub(crate) use stubs::*;

pub const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
pub const ORIGIN: &str = "http://127.0.0.1:7000";
pub const SEGMENT: &str = "e30";

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
        // Campos novos (F3) herdam o default: o dublê nunca liga a conta nativa.
        ..OrchestratorConfig::default()
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
        released: None,
        first_aired: None,
        episode_aired_at_ms: None,
        home_release_at: None,
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
