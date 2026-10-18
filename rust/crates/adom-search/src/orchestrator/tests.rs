//! Testes do orquestrador: SWR, coalescing, corte de prazo, HMAC, aviso,
//! host só na resposta e trace serializado.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::{RankingStream, StreamDisplayConfig};
use serde_json::{json, Value};

use super::*;
use crate::cache::MemorySwrStore;
use crate::collection_window::CollectBudgets;
use crate::list_builder::{BuildOptions, DebridAnswer, DebridCheck};

const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
const ORIGIN: &str = "http://127.0.0.1:7000";
const SEGMENT: &str = "e30";

// ── Stubs ───────────────────────────────────────────────────────────────────

struct StubCollector {
    batches: Mutex<Vec<CollectBatch>>,
    calls: AtomicUsize,
    delay: Duration,
    fail: bool,
}

impl StubCollector {
    fn with(items: Vec<RawItem>) -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(vec![CollectBatch {
                items,
                partial: false,
            }]),
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: false,
        })
    }

    fn empty() -> Arc<Self> {
        Self::with(Vec::new())
    }

    fn failing() -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(Vec::new()),
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: true,
        })
    }

    fn slow(items: Vec<RawItem>, delay: Duration) -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(vec![CollectBatch {
                items,
                partial: false,
            }]),
            calls: AtomicUsize::new(0),
            delay,
            fail: false,
        })
    }

    fn calls(&self) -> usize {
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
            let mut guard = self.batches.lock().expect("batches");
            if guard.is_empty() {
                Ok(CollectBatch::default())
            } else {
                Ok(guard.remove(0))
            }
        })
    }
}

struct StubMeta(SearchMeta);

impl MetaSource for StubMeta {
    fn resolve<'a>(&'a self, _req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
}

struct StubCheck {
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

struct StubDebrid {
    cached: Vec<String>,
}

impl DebridFactory for StubDebrid {
    fn make(&self, _ctx: &DebridContext) -> Box<dyn DebridCheck + Send> {
        Box::new(StubCheck {
            cached: self.cached.clone(),
        })
    }
}

#[derive(Default)]
struct RecordingTail {
    index: Mutex<Vec<IndexBatch>>,
}

impl RecordingTail {
    fn index_writes(&self) -> Vec<IndexBatch> {
        self.index.lock().expect("index").clone()
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
        _batch: EffectsBatch,
    ) -> RouteFuture<'a, crate::internal_types::EffectsResponse> {
        Box::pin(async {
            Ok(crate::internal_types::EffectsResponse {
                ok: true,
                accepted: 0,
                rejected: 0,
            })
        })
    }
}

// ── Cenário ─────────────────────────────────────────────────────────────────

fn options() -> Value {
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

fn config() -> OrchestratorConfig {
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
    }
}

fn meta() -> SearchMeta {
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
        sweep_query: None,
        original_query: None,
        multi_work_root: None,
        multi_work_query: None,
        episode_counts: Vec::new(),
        is_demo: false,
    }
}

fn item(hash: &str) -> RawItem {
    RawItem {
        title: Some("Filme Teste 2024 1080p WEB-DL x264".into()),
        info_hash: Some(hash.into()),
        seeders: Some(20.0),
        indexer: Some("bludv".into()),
        ..RawItem::default()
    }
}

fn request(now: i64) -> StreamRequest {
    StreamRequest {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        user_agent: Some("Stremio/1.6".into()),
        origin: Some(ORIGIN.into()),
        now_ms: Some(now),
    }
}

fn orchestrator(
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

fn entry_key(orch: &Orchestrator) -> String {
    let options = orch.resolve_options(&Some(SEGMENT.into()));
    request_cache_key("movie", "tt0133093", &orch.key_options(&options))
}

fn percent_decode(text: &str) -> String {
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

// ── SWR ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn hit_swr_servivel_nao_recomputa() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item(HASH)]);
    let orch = orchestrator(config(), store.clone(), collector.clone(), &[HASH]);

    let primeira = orch.handle(request(1_000_000)).await;
    assert_eq!(primeira.streams.len(), 1);
    assert_eq!(collector.calls(), 1);

    // Segunda abertura: hit fresco serve direto (sem nova coleta) e com o host
    // de QUEM pergunta (a entrada guarda só o path relativo).
    let segunda = orch.handle(request(1_000_000)).await;
    assert_eq!(segunda.streams.len(), 1);
    assert_eq!(collector.calls(), 1, "hit não pode recomputar");
    assert_eq!(primeira.streams[0].url, segunda.streams[0].url);
    assert!(segunda.streams[0]
        .url
        .as_deref()
        .unwrap_or("")
        .starts_with(ORIGIN));
    assert_eq!(segunda.cache_max_age, 900);
}

#[tokio::test]
async fn hit_stale_serve_e_revalida_em_fundo() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item(HASH)]);
    let orch = orchestrator(config(), store.clone(), collector.clone(), &[HASH]);

    let _ = orch.handle(request(1_000_000)).await;
    assert_eq!(collector.calls(), 1);
    // TTL de 60s (teto do store): 61s depois a entrada está stale mas na graça.
    let stale = orch.handle(request(1_061_500)).await;
    assert_eq!(stale.streams.len(), 1, "stale serve na hora");
    assert_eq!(stale.cache_max_age, 900);
    // A revalidação roda em fundo: a segunda coleta acontece depois.
    for _ in 0..40 {
        if collector.calls() > 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(collector.calls() > 1, "revalidação de fundo não rodou");
    assert_eq!(orch.searches_in_flight(), 0);
}

// ── Miss → coleta → build → HMAC ────────────────────────────────────────────

#[tokio::test]
async fn miss_coleta_build_resposta_com_hmac_e_aviso() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item(HASH)]);
    let orch = orchestrator(config(), store.clone(), collector.clone(), &[HASH]);

    let resposta = orch.handle(request(1_000_000)).await;
    assert_eq!(resposta.streams.len(), 1);
    let url = resposta.streams[0].url.as_deref().expect("url de play");
    assert!(
        url.starts_with(&format!("{ORIGIN}/{SEGMENT}/resolve/{HASH}?w=")),
        "{url}"
    );
    assert_eq!(resposta.cache_max_age, 900);

    // HMAC conferido pelo MESMO verificador da rota `/resolve`.
    let (rest, sig) = url.rsplit_once("sig=").expect("sig na URL");
    let encoded_hint = rest
        .trim_end_matches('&')
        .split("?w=")
        .nth(1)
        .expect("dica w");
    let hint = percent_decode(encoded_hint);
    assert!(hint.contains("\"n\":[\"Filme Teste\"]"), "{hint}");
    assert!(hint.contains("\"y\":2024"), "{hint}");
    assert!(hint.contains("\"i\":\"tt0133093\""), "{hint}");
    assert!(adom_core::verify_resolve(
        HASH,
        "",
        Some(sig),
        &hint,
        "chave-teste"
    ));

    // Entrada do cache: URL RELATIVA e sem host em lugar nenhum.
    let entry = store
        .get_with_stale(&entry_key(&orch), 300, 1_000_000)
        .expect("entrada gravada")
        .value;
    let gravado = serde_json::to_string(&entry).expect("json");
    assert!(!gravado.contains("127.0.0.1"), "host vazou: {gravado}");
    assert_eq!(
        entry.streams[0].url.as_deref(),
        Some(format!("/{SEGMENT}/resolve/{HASH}?w={encoded_hint}&sig={sig}").as_str())
    );

    // Lista sem candidato (série) → aviso de lista vazia, nunca 500.
    let mut serie = meta();
    serie.season = Some(1);
    serie.episode = Some(1);
    serie.query = "Filme Teste S01E01".into();
    let vazio = StubCollector::empty();
    let orch = Orchestrator::new(config(), store.clone())
        .with_collector(vazio)
        .with_meta(Arc::new(StubMeta(serie)))
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }));
    let aviso = orch
        .handle(StreamRequest {
            kind: "series".into(),
            id: "tt0903747:1:1".into(),
            encoded: Some(SEGMENT.into()),
            user_agent: None,
            origin: Some(ORIGIN.into()),
            now_ms: Some(1_000_000),
        })
        .await;
    assert_eq!(aviso.streams.len(), 1);
    assert!(aviso.streams[0]
        .name
        .as_deref()
        .unwrap_or("")
        .contains("Nada pronto ainda"));
    assert_eq!(
        aviso.streams[0].external_url.as_deref(),
        Some(format!("{ORIGIN}/{SEGMENT}/configure").as_str())
    );
    assert_eq!(aviso.cache_max_age, 0);
}

#[tokio::test]
async fn erro_de_collector_vira_lista_vazia_com_aviso() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::failing();
    let orch = orchestrator(config(), store.clone(), collector.clone(), &[]);
    let resposta = orch.handle(request(1_000_000)).await;
    assert_eq!(resposta.streams.len(), 1, "aviso no lugar da lista");
    assert_eq!(resposta.streams[0].name.as_deref(), Some(NOTICE_SEARCHING));
    assert_eq!(resposta.cache_max_age, 0);
    assert_eq!(
        resposta.streams[0].external_url.as_deref(),
        Some(format!("{ORIGIN}/{SEGMENT}/configure").as_str())
    );
    // Nada de cache "vazio confiável".
    assert!(store
        .get_with_stale(&entry_key(&orch), 300, 1_000_000)
        .map(|hit| hit.value.streams.is_empty())
        .unwrap_or(true));
}

// ── Coalescing ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn duas_requisicoes_simultaneas_uma_busca() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::slow(vec![item(HASH)], Duration::from_millis(80));
    let orch = Arc::new(orchestrator(
        config(),
        store.clone(),
        collector.clone(),
        &[HASH],
    ));

    let a = {
        let orch = orch.clone();
        tokio::spawn(async move { orch.handle(request(1_000_000)).await })
    };
    let b = {
        let orch = orch.clone();
        tokio::spawn(async move { orch.handle(request(1_000_000)).await })
    };
    let (a, b) = (a.await.expect("a"), b.await.expect("b"));
    assert_eq!(collector.calls(), 1, "uma única coleta para a mesma chave");
    assert_eq!(a.streams.len(), 1);
    assert_eq!(a.streams[0].url, b.streams[0].url);
    assert!(orch.searches_in_flight() == 0 || orch.searches_in_flight() <= 1);
}

// ── Trace ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn trace_serializado_no_formato_do_stream_trace() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item(HASH)]);
    let orch = orchestrator(config(), store.clone(), collector, &[HASH]);
    let _ = orch.handle(request(1_000_000)).await;

    let entry = store
        .get_with_stale(&entry_key(&orch), 300, 1_000_000)
        .expect("entrada")
        .value;
    let trace = entry.trace.expect("ledger gravado");
    assert_eq!(
        trace.get("startedAt").and_then(Value::as_f64),
        Some(1_000_000.0)
    );
    assert!(trace.get("finishedAt").and_then(Value::as_f64).is_some());
    let stages = trace.get("stages").expect("stages");
    assert_eq!(stages.get("raw").and_then(Value::as_u64), Some(1));
    assert_eq!(stages.get("final").and_then(Value::as_u64), Some(1));
    assert!(stages.get("afterSort").is_some());
    // `searchMeta` também viaja para o `/stream-trace.json` offline.
    assert_eq!(
        entry.search_meta.as_ref().and_then(|m| m.get("year")),
        Some(&json!("2024"))
    );
}

// ── Corte externo + continuação em fundo + fila tardia ─────────────────────

#[tokio::test]
async fn corte_de_prazo_parcial_continua_em_fundo_e_grava_no_store() {
    let now = 1_000_000;
    let mut config = config();
    // Prazo de resposta curtíssimo: a coleta (120ms) não cabe.
    config.stremio_reply_ms = 40;
    config.budgets.reply_deadline_ms = 40;
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::slow(vec![item(HASH)], Duration::from_millis(120));
    let tail = Arc::new(RecordingTail::default());
    let orch =
        orchestrator(config, store.clone(), collector.clone(), &[HASH]).with_tail(tail.clone());
    let key = entry_key(&orch);

    let resposta = orch.handle(request(now)).await;
    assert_eq!(resposta.streams.len(), 1);
    assert_eq!(
        resposta.streams[0].name.as_deref(),
        Some(NOTICE_SEARCHING),
        "corte externo devolve o aviso"
    );
    assert_eq!(resposta.cache_max_age, 0);
    // A resposta saiu ANTES da coleta terminar: store vazio e fila tardia
    // ainda não disparou (nada de esperar o fundo dentro da resposta).
    assert!(store.get_with_stale(&key, 300, now as u64).is_none());
    assert!(
        tail.index_writes().is_empty(),
        "fila tardia fora da resposta"
    );

    // O passe tardio termina em fundo e grava a lista COMPLETA.
    let mut entry = None;
    for _ in 0..80 {
        if let Some(hit) = store.get_with_stale(&key, 300, now as u64) {
            if !hit.value.streams.is_empty() {
                entry = Some(hit.value);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let entry = entry.expect("continuação em fundo precisa gravar no store");
    assert_eq!(entry.streams.len(), 1);
    assert!(!entry.partial, "coleta encerrada = entrada completa");
    assert_eq!(entry.debrid_known, Some(true));

    // Fila tardia: index-write entregue DEPOIS da resposta, pelo TailEffects.
    for _ in 0..80 {
        if !tail.index_writes().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let writes = tail.index_writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].encoded, SEGMENT);
    assert_eq!(writes[0].releases.len(), 1);
    assert_eq!(writes[0].releases[0].imdb, "tt0133093");
    assert!(!writes[0].releases[0].items.is_empty());
    assert_eq!(collector.calls(), 1);
}
