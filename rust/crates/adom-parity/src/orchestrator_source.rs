//! [`StreamSource`] sobre `adom_search::orchestrator::Orchestrator`.
//!
//! A costura da Fase A: o runner compara o Node gravado no corpus com o que o
//! orquestrador remonta. Coleta/meta/debrid entram por stubs (fixture no disco
//! ou injeção em teste). Sem `meta.json`+`raw.json` o caso é **pulado** — nunca
//! falso-verde contra a lista do golden.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use adom_core::StreamDisplayConfig;
use adom_search::cache::MemorySwrStore;
use adom_search::collection_window::CollectBudgets;
use adom_search::list_builder::BuildOptions;
use adom_search::orchestrator::{
    NoopTailEffects, Orchestrator, OrchestratorConfig, SearchMeta, StreamRequest,
};
use adom_search::raw_item::RawItem;
use serde_json::{json, Value};
use tokio::runtime::Runtime;

use crate::corpus::Case;
use crate::runner::{ProduceOutcome, SourceError, StreamSource};

/// Segmento base64url de `{}` — troca o `{{config}}` mascarado do corpus.
pub const DEFAULT_CONFIG_SEGMENT: &str = "e30";
/// Origem de teste alinhada ao corpus / orquestrador.
pub const DEFAULT_ORIGIN: &str = "http://127.0.0.1:7000";
/// Relógio fixo — fora do diff (§9.3).
pub const DEFAULT_NOW_MS: i64 = 1_000_000;

/// Fixtures que alimentam os stubs do orquestrador para UM caso.
#[derive(Debug, Clone)]
pub struct CaseFixtures {
    pub meta: SearchMeta,
    pub raw: Vec<RawItem>,
    /// Hashes que o debrid stub marca como ⚡.
    pub cached_hashes: Vec<String>,
}

impl CaseFixtures {
    /// Lê `meta.json` + `raw.json` (+ `debrid.json` opcional) no diretório do
    /// caso. Ausência de meta/raw → `None` (caller deve pular).
    pub fn load_dir(dir: &Path) -> Result<Option<Self>, SourceError> {
        let meta_path = dir.join("meta.json");
        let raw_path = dir.join("raw.json");
        if !meta_path.is_file() || !raw_path.is_file() {
            return Ok(None);
        }
        let meta_bytes = fs::read(&meta_path)
            .map_err(|e| SourceError::new(format!("não li {}: {e}", meta_path.display())))?;
        let raw_bytes = fs::read(&raw_path)
            .map_err(|e| SourceError::new(format!("não li {}: {e}", raw_path.display())))?;
        let meta_value: Value = serde_json::from_slice(&meta_bytes)
            .map_err(|e| SourceError::new(format!("meta.json inválido: {e}")))?;
        let raw_value: Value = serde_json::from_slice(&raw_bytes)
            .map_err(|e| SourceError::new(format!("raw.json inválido: {e}")))?;
        let meta = search_meta_from_fixture(&meta_value)?;
        let raw = raw_items_from_fixture(&raw_value)?;
        let cached_hashes = match dir.join("debrid.json") {
            path if path.is_file() => {
                let bytes = fs::read(&path)
                    .map_err(|e| SourceError::new(format!("não li {}: {e}", path.display())))?;
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|e| SourceError::new(format!("debrid.json inválido: {e}")))?;
                cached_hashes_from_fixture(&value)
            }
            _ => Vec::new(),
        };
        Ok(Some(CaseFixtures {
            meta,
            raw,
            cached_hashes,
        }))
    }
}

/// Fonte fixa: um orquestrador já montado com stubs (teste / fixture única).
pub struct OrchestratorSource {
    runtime: Runtime,
    orch: Orchestrator,
    config_segment: String,
    origin: String,
    now_ms: i64,
}

impl OrchestratorSource {
    /// Monta orquestrador com collector/meta/debrid stubs a partir das fixtures.
    pub fn from_fixtures(fixtures: CaseFixtures) -> Result<Self, SourceError> {
        Self::from_fixtures_with(fixtures, SourceOptions::default())
    }

    pub fn from_fixtures_with(
        fixtures: CaseFixtures,
        options: SourceOptions,
    ) -> Result<Self, SourceError> {
        let runtime =
            Runtime::new().map_err(|e| SourceError::new(format!("runtime tokio: {e}")))?;
        let store = Arc::new(MemorySwrStore::new());
        let collector = StubCollector::with(fixtures.raw);
        let orch = Orchestrator::new(stub_config(), store)
            .with_collector(collector)
            .with_meta(Arc::new(StubMeta(fixtures.meta)))
            .with_debrid(Arc::new(StubDebrid {
                cached: fixtures.cached_hashes,
            }))
            .with_tail(Arc::new(NoopTailEffects));
        Ok(OrchestratorSource {
            runtime,
            orch,
            config_segment: options.config_segment,
            origin: options.origin,
            now_ms: options.now_ms,
        })
    }

    /// Opções de path/origin/relógio usadas no `produce`.
    pub fn options(&self) -> SourceOptions {
        SourceOptions {
            config_segment: self.config_segment.clone(),
            origin: self.origin.clone(),
            now_ms: self.now_ms,
        }
    }
}

impl StreamSource for OrchestratorSource {
    fn produce(&self, case: &Case) -> Result<ProduceOutcome, SourceError> {
        let body = produce_with_orch(
            &self.runtime,
            &self.orch,
            case,
            &self.config_segment,
            &self.origin,
            self.now_ms,
        )?;
        Ok(ProduceOutcome::Body(body))
    }
}

/// Percorre o corpus: com fixtures remonta; sem meta/raw → skip honesto.
pub struct FixtureOrchestratorSource {
    corpus_root: PathBuf,
    runtime: Runtime,
    options: SourceOptions,
}

impl FixtureOrchestratorSource {
    pub fn for_corpus(corpus_root: impl Into<PathBuf>) -> Result<Self, SourceError> {
        Self::for_corpus_with(corpus_root, SourceOptions::default())
    }

    pub fn for_corpus_with(
        corpus_root: impl Into<PathBuf>,
        options: SourceOptions,
    ) -> Result<Self, SourceError> {
        let runtime =
            Runtime::new().map_err(|e| SourceError::new(format!("runtime tokio: {e}")))?;
        Ok(FixtureOrchestratorSource {
            corpus_root: corpus_root.into(),
            runtime,
            options,
        })
    }
}

impl StreamSource for FixtureOrchestratorSource {
    fn produce(&self, case: &Case) -> Result<ProduceOutcome, SourceError> {
        let dir = case_dir(&self.corpus_root, case);
        let Some(fixtures) = CaseFixtures::load_dir(&dir)? else {
            return Ok(ProduceOutcome::Skip {
                reason: format!(
                    "caso sem meta.json/raw.json em {} — remontagem impossível",
                    dir.display()
                ),
            });
        };
        let store = Arc::new(MemorySwrStore::new());
        let orch = Orchestrator::new(stub_config(), store)
            .with_collector(StubCollector::with(fixtures.raw))
            .with_meta(Arc::new(StubMeta(fixtures.meta)))
            .with_debrid(Arc::new(StubDebrid {
                cached: fixtures.cached_hashes,
            }))
            .with_tail(Arc::new(NoopTailEffects));
        let body = produce_with_orch(
            &self.runtime,
            &orch,
            case,
            &self.options.config_segment,
            &self.options.origin,
            self.options.now_ms,
        )?;
        Ok(ProduceOutcome::Body(body))
    }
}

/// Path/origin/relógio injetados na remontagem.
#[derive(Debug, Clone)]
pub struct SourceOptions {
    pub config_segment: String,
    pub origin: String,
    pub now_ms: i64,
}

impl Default for SourceOptions {
    fn default() -> Self {
        Self {
            config_segment: DEFAULT_CONFIG_SEGMENT.to_string(),
            origin: DEFAULT_ORIGIN.to_string(),
            now_ms: DEFAULT_NOW_MS,
        }
    }
}

fn case_dir(corpus_root: &Path, case: &Case) -> PathBuf {
    let relative = if case.meta.dir.is_empty() {
        format!("cases/{}", case.meta.id)
    } else {
        case.meta.dir.clone()
    };
    corpus_root.join(relative)
}

fn produce_with_orch(
    runtime: &Runtime,
    orch: &Orchestrator,
    case: &Case,
    config_segment: &str,
    origin: &str,
    now_ms: i64,
) -> Result<Value, SourceError> {
    let path = case.request.path.replace("{{config}}", config_segment);
    let ua = case
        .request
        .headers
        .get("user-agent")
        .or_else(|| case.request.headers.get("User-Agent"))
        .map(String::as_str);
    let req = StreamRequest::from_path(&path, ua, Some(origin), Some(now_ms)).ok_or_else(|| {
        SourceError::new(format!(
            "path inválido para StreamRequest: {} (caso {})",
            path, case.meta.id
        ))
    })?;
    let response = runtime.block_on(orch.handle(req));
    serde_json::to_value(response)
        .map_err(|e| SourceError::new(format!("serialização StreamResponse: {e}")))
}

fn stub_config() -> OrchestratorConfig {
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
        defaults: stub_defaults(),
        resolve_secret: String::new(),
        resolve_uncached: false,
        build: BuildOptions::default(),
        display: StreamDisplayConfig::default(),
        selected_indexers: Vec::new(),
        pt_br_indexers: Vec::new(),
        isolate_indexers: Vec::new(),
        index_only_indexers: Vec::new(),
        sweep_enabled: false,
        trace_enabled: false,
        search_index_rescue_min_ms: 2500,
    }
}

fn stub_defaults() -> Value {
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
#[path = "orchestrator_source_stubs.rs"]
mod stubs;
use stubs::*;
