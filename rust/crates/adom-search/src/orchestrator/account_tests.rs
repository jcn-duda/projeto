//! Testes do inventário NATIVO da conta (F3): sondas de áudio/origem, filtro
//! de relevância, shape do item, fast-path, amostragem, memo e a integração
//! com a janela de coleta (sem a tarefa Node da conta).

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use adom_core::RelevanceSettings;
use adom_debrid::account::{AccountInventory, InventoryItem};
use serde_json::json;

use super::{
    account_raw_items, br_origin_only, fast_path_decision, sampled, signals_of,
    try_native_account_source, AccountInventorySource, AccountMode, AccountRequest,
    FastPathDecision, NativeAccountConfig, NativeAccountSource,
};
use crate::collection_window::BatchMeta;
use crate::internal_types::{
    CollectRequest, CollectResponse, EffectsRequest, EffectsResponse, IndexWriteRequest,
    IndexWriteResponse, MetaRequest, MetaResponse, SearchIndexRequest, SearchIndexResponse,
};
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::config::OrchestratorConfig;
use crate::orchestrator::finish::SearchInput;
use crate::orchestrator::internal_routes::{InternalRoutes, RouteFuture};
use crate::orchestrator::meta::SearchMeta;
use crate::orchestrator::Orchestrator;
use crate::MemorySwrStore;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn settings() -> RelevanceSettings {
    RelevanceSettings {
        now_ms: 1_700_000_000_000,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: 48 * 3_600_000,
        title_precision_tail_cut: true,
    }
}

fn meta(names: &[&str], year: i64, season: Option<i64>, episode: Option<i64>) -> SearchMeta {
    SearchMeta {
        imdb_id: "tt0133093".into(),
        names: names.iter().map(|name| name.to_string()).collect(),
        year: json!(year),
        query: "Matrix 1999".into(),
        season,
        episode,
        ..SearchMeta::default()
    }
}

fn items(rows: &[(&str, &str)]) -> Vec<InventoryItem> {
    rows.iter()
        .map(|(title, hash)| InventoryItem {
            title: (*title).to_string(),
            info_hash: (*hash).to_string(),
            size: 4_000_000_000.0,
            id: None,
        })
        .collect()
}

// ── Sondas e filtro ────────────────────────────────────────────────────────

#[test]
fn sondas_de_audio_e_origem() {
    let dublado = signals_of("Filme Dublado 1080p");
    assert!(dublado.pt_audio, "Dublado é PT explícito");
    assert!(!dublado.legendado);

    let legendado = signals_of("Filme Legendado 1080p");
    assert!(legendado.legendado);
    assert!(!legendado.pt_audio);

    let estrangeiro = signals_of("Filme FRENCH 1080p");
    assert!(estrangeiro.explicit_foreign);

    // Caso Zombieland: origem BR pelo nome (WWW.BLUDV.COM + acento), sem
    // prometer áudio dublado.
    let origem = signals_of("Zumbilândia 2009 [1080p] WWW.BLUDV.COM");
    assert!(origem.br_origin);
    assert!(!origem.pt_audio);
    assert!(br_origin_only(&origem));
    // Dublado + origem: NÃO é só-origem (o áudio já prova por si).
    let origem_dublada = signals_of("Zumbilândia 2009 Bluray 1080p Dublado");
    assert!(origem_dublada.pt_audio);
    assert!(!br_origin_only(&origem_dublada));
    // Estrangeiro explícito desmente a origem.
    let origem_estrangeira = signals_of("Zumbilândia 2009 FRENCH WWW.BLUDV.COM");
    assert!(origem_estrangeira.explicit_foreign);
    assert!(!br_origin_only(&origem_estrangeira));
}

#[test]
fn filtro_da_conta_casa_a_obra_e_marca_o_item() {
    let inventory = items(&[
        ("Matrix Dublado 1080p", HASH_A),
        ("Outro Filme Dublado 1080p", HASH_B),
    ]);
    let raws = account_raw_items(
        &inventory,
        &meta(&["Matrix"], 1999, None, None),
        settings(),
        "AllDebrid",
    );
    assert_eq!(raws.len(), 1, "só a obra pedida entra");
    let item = &raws[0];
    assert_eq!(item.title.as_deref(), Some("Matrix Dublado 1080p"));
    assert_eq!(item.info_hash.as_deref(), Some(HASH_A));
    assert!(item.from_account);
    assert_eq!(item.indexer.as_deref(), Some("debrid"));
    assert_eq!(item.tracker.as_deref(), Some("AllDebrid"));
    assert_eq!(item.seeders, Some(1.0), "conta não tem swarm: 1 é neutro");
    assert!(item.is_br);
}

#[test]
fn item_de_origem_br_fica_is_br_e_br_origin_only() {
    let inventory = items(&[("Zumbilândia 2009 [1080p] WWW.BLUDV.COM", HASH_A)]);
    let raws = account_raw_items(
        &inventory,
        &meta(&["Zumbilândia"], 2009, None, None),
        settings(),
        "AllDebrid",
    );
    assert_eq!(raws.len(), 1);
    assert!(raws[0].is_br, "_br da origem-forte dá vaga reservada");
    assert!(raws[0].br_origin_only, "não promete dublado");
}

#[test]
fn filtro_sem_nomes_ou_inventario_vazio_devolve_vazio() {
    assert!(account_raw_items(
        &items(&[("Matrix Dublado", HASH_A)]),
        &meta(&[], 1999, None, None),
        settings(),
        "AllDebrid"
    )
    .is_empty());
    assert!(account_raw_items(
        &[],
        &meta(&["Matrix"], 1999, None, None),
        settings(),
        "AllDebrid"
    )
    .is_empty());
}

#[test]
fn serie_corta_pelo_episodio_como_o_node() {
    let inventory = items(&[
        ("Matrix S01E02 Dublado 1080p", HASH_A),
        ("Matrix S01E03 Dublado 1080p", HASH_B),
    ]);
    let raws = account_raw_items(
        &inventory,
        &meta(&["Matrix"], 1999, Some(1), Some(2)),
        settings(),
        "AllDebrid",
    );
    assert_eq!(raws.len(), 1);
    assert_eq!(raws[0].info_hash.as_deref(), Some(HASH_A));
}

// ── Fast-path ──────────────────────────────────────────────────────────────

fn raw(title: &str, hash: &str, is_br: bool) -> crate::RawItem {
    crate::RawItem {
        title: Some(title.into()),
        info_hash: Some(hash.into()),
        seeders: Some(1.0),
        is_br,
        from_account: true,
        ..crate::RawItem::default()
    }
}

fn account_batch() -> BatchMeta {
    BatchMeta {
        priority: false,
        source: Some("account".into()),
    }
}

#[test]
fn fast_path_so_do_lote_da_conta() {
    let batch = vec![
        raw("Matrix Dublado 1080p", HASH_A, true),
        raw("Matrix Dublado 720p", HASH_B, true),
    ];
    let outro = BatchMeta {
        priority: false,
        source: Some("jackett".into()),
    };
    assert_eq!(
        fast_path_decision(&batch, &outro, 2, false, None, 0.0),
        FastPathDecision::NotAccount
    );
    assert_eq!(
        fast_path_decision(&batch, &account_batch(), 2, false, None, 0.0),
        FastPathDecision::Covered
    );
    assert_eq!(
        fast_path_decision(&batch, &account_batch(), 3, false, None, 0.0),
        FastPathDecision::TooFew
    );
}

#[test]
fn fast_path_com_prefer_dubbed_exige_cobertura() {
    let sem_dublado = vec![
        raw("Matrix 1080p", HASH_A, false),
        raw("Matrix 720p", HASH_B, false),
    ];
    assert_eq!(
        fast_path_decision(&sem_dublado, &account_batch(), 2, true, None, 0.0),
        FastPathDecision::NotCovered
    );
    let com_dublado = vec![
        raw("Matrix Dublado 1080p", HASH_A, true),
        raw("Matrix Dublado 720p", HASH_B, true),
    ];
    assert_eq!(
        fast_path_decision(&com_dublado, &account_batch(), 2, true, None, 0.0),
        FastPathDecision::Covered
    );
}

#[test]
fn amostragem_e_deterministica_e_limitada() {
    assert!(!sampled("tt0133093", 0.0), "0% nunca amostra");
    assert!(sampled("tt0133093", 1.0), "100% sempre amostra");
    let first = sampled("tt0133093", 0.5);
    let second = sampled("tt0133093", 0.5);
    assert_eq!(first, second, "mesma obra, mesma decisão");
    // A fração tem que separar alguma coisa numa lista real de ids.
    let hits = (0..200)
        .filter(|n| sampled(&format!("tt{n:07}"), 0.25))
        .count();
    assert!(
        hits > 10 && hits < 90,
        "amostra de 25% fora da faixa: {hits}"
    );
}

#[test]
fn modo_parse_e_default_off() {
    assert_eq!(AccountMode::parse(""), AccountMode::Off);
    assert_eq!(AccountMode::parse("off"), AccountMode::Off);
    assert_eq!(AccountMode::parse("shadow"), AccountMode::Shadow);
    assert_eq!(AccountMode::parse(" SHADOW "), AccountMode::Shadow);
    assert_eq!(AccountMode::parse("on"), AccountMode::On);
    assert_eq!(AccountMode::parse("true"), AccountMode::On);
    assert_eq!(AccountMode::parse("1"), AccountMode::On);
    assert_eq!(AccountMode::parse("qualquer"), AccountMode::Off);
    assert!(!AccountMode::Off.uses_native());
    assert!(AccountMode::Shadow.uses_native());
    assert!(AccountMode::On.is_on());
}

#[test]
fn fonte_nativa_so_e_montada_quando_o_modo_pede() {
    let mut config = OrchestratorConfig::default();
    assert!(try_native_account_source(&config).is_none());
    config.account_mode = AccountMode::On;
    assert!(try_native_account_source(&config).is_some());
    config.account_mode = AccountMode::Shadow;
    assert!(try_native_account_source(&config).is_some());
}

// ── Memo do inventário (servidor falso em loopback) ────────────────────────

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone)]
struct Mock {
    hits: Arc<AtomicUsize>,
    status: u16,
    body: Arc<String>,
}

async fn respond(
    axum::extract::State(mock): axum::extract::State<Mock>,
) -> impl axum::response::IntoResponse {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    (
        axum::http::StatusCode::from_u16(mock.status).unwrap_or(axum::http::StatusCode::OK),
        mock.body.to_string(),
    )
}

async fn server(status: u16, body: &str) -> (std::net::SocketAddr, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let mock = Mock {
        hits: hits.clone(),
        status,
        body: Arc::new(body.to_string()),
    };
    let app = axum::Router::new()
        .fallback(axum::routing::any(respond))
        .with_state(mock);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, hits)
}

/// Segura a env enquanto o `NativeAccountSource` lê a base do AllDebrid.
struct EnvGuard {
    prev: Option<String>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn set(addr: std::net::SocketAddr) -> Self {
        let lock = ENV_LOCK.lock().unwrap_or_else(|err| err.into_inner());
        let prev = std::env::var("ALLDEBRID_API_BASE").ok();
        unsafe {
            std::env::set_var("ALLDEBRID_API_BASE", format!("http://{addr}"));
        }
        EnvGuard { prev, _lock: lock }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        unsafe {
            match &self.prev {
                Some(value) => std::env::set_var("ALLDEBRID_API_BASE", value),
                None => std::env::remove_var("ALLDEBRID_API_BASE"),
            }
        }
    }
}

fn alldebrid_body() -> String {
    json!({
        "status": "success",
        "data": { "magnets": [
            { "id": 1, "hash": HASH_A, "filename": "Matrix Dublado 1080p",
              "ready": true, "size": 4_000_000_000i64 },
            { "id": 2, "hash": HASH_B, "filename": "Matrix Dublado 720p",
              "status": "Ready", "size": 1_500_000_000i64 },
        ]}
    })
    .to_string()
}

fn request() -> AccountRequest {
    AccountRequest {
        service: "alldebrid".into(),
        api_key: "chave-de-teste".into(),
    }
}

fn native_source(ttl_ms: i64) -> NativeAccountSource {
    NativeAccountSource::new(NativeAccountConfig {
        timeout: Duration::from_millis(500),
        max: 10,
        ttl_ms,
    })
}

#[tokio::test]
async fn memo_do_inventario_evita_segunda_leitura() {
    let (addr, hits) = server(200, &alldebrid_body()).await;
    let _env = EnvGuard::set(addr);
    let source = native_source(60_000);
    let first = source.inventory(request()).await.expect("leitura");
    assert!(first.known);
    assert_eq!(first.items.len(), 2);
    let second = source.inventory(request()).await.expect("memo");
    assert_eq!(second.items.len(), 2);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "memo quente não bate na API"
    );
}

#[tokio::test]
async fn memo_com_ttl_zero_rele_a_conta() {
    let (addr, hits) = server(200, &alldebrid_body()).await;
    let _env = EnvGuard::set(addr);
    let source = native_source(0);
    source.inventory(request()).await.expect("1ª leitura");
    source.inventory(request()).await.expect("2ª leitura");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "TTL vencido volta ao serviço (dinv expira)"
    );
}

#[tokio::test]
async fn falha_nunca_fica_no_memo() {
    let (addr, hits) = server(500, "{}").await;
    let _env = EnvGuard::set(addr);
    let source = native_source(60_000);
    let first = source.inventory(request()).await.expect("veredito");
    assert!(!first.known);
    let second = source.inventory(request()).await.expect("retry");
    assert!(!second.known);
    assert_eq!(hits.load(Ordering::SeqCst), 2, "erro não é cacheado");
}

// ── Integração com a janela de coleta ──────────────────────────────────────

struct StubInventory {
    inventory: AccountInventory,
}

impl AccountInventorySource for StubInventory {
    fn inventory<'a>(
        &'a self,
        _req: AccountRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AccountInventory, String>> + Send + 'a>> {
        let inventory = self.inventory.clone();
        Box::pin(async move { Ok(inventory) })
    }
}

fn stub_inventory() -> Arc<StubInventory> {
    Arc::new(StubInventory {
        inventory: AccountInventory {
            items: items(&[
                ("Matrix Dublado 1080p", HASH_A),
                ("Matrix Dublado 720p", HASH_B),
            ]),
            known: true,
            unusable: None,
        },
    })
}

struct StubCollector {
    delay: Duration,
}

impl Collector for StubCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        let delay = self.delay;
        Box::pin(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            Ok(CollectBatch::default())
        })
    }
}

#[derive(Default)]
struct CountingRoutes {
    collect_calls: AtomicUsize,
    last_skip_sources: Mutex<Vec<String>>,
}

impl CountingRoutes {
    fn empty_collect(&self) -> CollectResponse {
        CollectResponse {
            ok: true,
            task_scope: "all".into(),
            query: String::new(),
            imdb_id: String::new(),
            season: None,
            episode: None,
            partial: false,
            items: Vec::new(),
            by_indexer: Default::default(),
            live: None,
            breaker: Default::default(),
            eligible: true,
        }
    }
}

impl InternalRoutes for CountingRoutes {
    fn meta<'a>(&'a self, _req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async { Err("não usado".into()) })
    }

    fn collect<'a>(&'a self, req: CollectRequest) -> RouteFuture<'a, CollectResponse> {
        self.collect_calls.fetch_add(1, Ordering::SeqCst);
        *self
            .last_skip_sources
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = req.skip_sources.clone();
        let response = self.empty_collect();
        Box::pin(async move { Ok(response) })
    }

    fn index_write<'a>(&'a self, _req: IndexWriteRequest) -> RouteFuture<'a, IndexWriteResponse> {
        Box::pin(async { Err("não usado".into()) })
    }

    fn effects<'a>(&'a self, _req: EffectsRequest) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async { Err("não usado".into()) })
    }

    fn search_index<'a>(
        &'a self,
        _req: SearchIndexRequest,
    ) -> RouteFuture<'a, SearchIndexResponse> {
        Box::pin(async { Err("não usado".into()) })
    }
}

fn input() -> SearchInput {
    SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some("cfg".into()),
        prefix: String::new(),
        options: json!({
            "debridService": "alldebrid",
            "debridApiKey": "chave-de-teste",
        }),
        key: "streams:v21:teste".into(),
        now_ms: 1_700_000_000_000,
        deadline_at: Some(1_700_000_003_000),
    }
}

fn orchestrator(
    mode: AccountMode,
    fast_path: bool,
    source: Option<Arc<StubInventory>>,
    routes: Arc<CountingRoutes>,
    delay: Duration,
) -> Orchestrator {
    // Um indexer selecionado garante o job base da conta (o `account_base` do
    // collect sai do primeiro job não prioritário).
    let config = OrchestratorConfig {
        account_mode: mode,
        account_fast_path: fast_path,
        selected_indexers: vec!["indexer-x".into()],
        sweep_enabled: false,
        ..OrchestratorConfig::default()
    };
    let orchestrator = Orchestrator::new(config, Arc::new(MemorySwrStore::new()))
        .with_collector(Arc::new(StubCollector { delay }))
        .with_internal_routes(routes);
    match source {
        Some(source) => orchestrator.with_account_source(source),
        None => orchestrator,
    }
}

#[tokio::test]
async fn modo_on_usa_a_fonte_nativa_e_nao_chama_a_conta_do_node() {
    let routes = Arc::new(CountingRoutes::default());
    let orch = orchestrator(
        AccountMode::On,
        false,
        Some(stub_inventory()),
        routes.clone(),
        Duration::ZERO,
    );
    let (items, _partial, completion, _failed, _live) = orch
        .collect_scoped(&input(), &meta(&["Matrix"], 1999, None, None), None)
        .await;
    let all = completion.expect("completion").await.expect("lote");
    assert!(items.iter().any(|item| item.from_account));
    assert!(all.iter().any(|item| item.from_account));
    assert_eq!(
        routes.collect_calls.load(Ordering::SeqCst),
        0,
        "modo on não delega a conta ao Node"
    );
}

#[tokio::test]
async fn servico_desconhecido_nao_vira_fonte_nem_no_modo_on() {
    let routes = Arc::new(CountingRoutes::default());
    let orch = orchestrator(
        AccountMode::On,
        true,
        Some(stub_inventory()),
        routes.clone(),
        Duration::ZERO,
    );
    let mut input = input();
    input.options = json!({
        "debridService": "servico-x",
        "debridApiKey": "chave-de-teste",
    });
    let (items, _partial, completion, _failed, _live) = orch
        .collect_scoped(&input, &meta(&["Matrix"], 1999, None, None), None)
        .await;
    let _ = completion.expect("completion").await;
    assert!(
        items.iter().all(|item| !item.from_account),
        "serviço sem adaptador não tem inventário (debrid.current() nulo)"
    );
    assert_eq!(routes.collect_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn modo_off_mantem_a_tarefa_node_da_conta() {
    let routes = Arc::new(CountingRoutes::default());
    let orch = orchestrator(
        AccountMode::Off,
        false,
        None,
        routes.clone(),
        Duration::ZERO,
    );
    let (_items, _partial, completion, _failed, _live) = orch
        .collect_scoped(&input(), &meta(&["Matrix"], 1999, None, None), None)
        .await;
    let _ = completion.expect("completion").await;
    assert_eq!(
        routes.collect_calls.load(Ordering::SeqCst),
        1,
        "default continua no Node"
    );
    let skip = routes
        .last_skip_sources
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone();
    assert_eq!(
        skip,
        vec!["jackett", "prowlarr", "torrentio", "bludv", "mico"],
        "a tarefa Node da conta pula as fontes de indexer"
    );
}

#[tokio::test]
async fn fast_path_responde_antes_da_coleta_lenta() {
    let routes = Arc::new(CountingRoutes::default());
    let orch = orchestrator(
        AccountMode::On,
        true,
        Some(stub_inventory()),
        routes,
        Duration::from_millis(300),
    );
    let start = Instant::now();
    let (_items, _partial, completion, _failed, _live) = orch
        .collect_scoped(&input(), &meta(&["Matrix"], 1999, None, None), None)
        .await;
    let elapsed = start.elapsed();
    // A conta chega na hora; sem o fast-path a janela esperaria o coletor.
    assert!(
        elapsed < Duration::from_millis(250),
        "fast-path não respondeu cedo: {elapsed:?}"
    );
    completion.expect("completion").abort();
}

#[tokio::test]
async fn fast_path_desligado_espera_a_coleta() {
    let routes = Arc::new(CountingRoutes::default());
    let orch = orchestrator(
        AccountMode::On,
        false,
        Some(stub_inventory()),
        routes,
        Duration::from_millis(150),
    );
    let start = Instant::now();
    let (_items, _partial, completion, _failed, _live) = orch
        .collect_scoped(&input(), &meta(&["Matrix"], 1999, None, None), None)
        .await;
    let elapsed = start.elapsed();
    assert!(
        elapsed >= Duration::from_millis(140),
        "sem fast-path a janela espera o coletor: {elapsed:?}"
    );
    let _ = completion.expect("completion").await;
}
