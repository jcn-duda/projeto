//! Parte 2 dos testes do inventário nativo da conta: memo do inventário
//! (servidor falso em loopback) e integração com a janela de coleta.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use adom_debrid::account::AccountInventory;
use serde_json::json;

use super::{items, meta, HASH_A, HASH_B};
use crate::orchestrator::account::{
    AccountInventorySource, AccountRequest, NativeAccountConfig, NativeAccountSource,
};
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::config::OrchestratorConfig;
use crate::orchestrator::finish::SearchInput;
use crate::orchestrator::Orchestrator;
use crate::MemorySwrStore;

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
    fast_path: bool,
    source: Option<Arc<StubInventory>>,
    delay: Duration,
) -> Orchestrator {
    let config = OrchestratorConfig {
        account_fast_path: fast_path,
        selected_indexers: vec!["indexer-x".into()],
        sweep_enabled: false,
        ..OrchestratorConfig::default()
    };
    let orchestrator = Orchestrator::new(config, Arc::new(MemorySwrStore::new()))
        .with_collector(Arc::new(StubCollector { delay }));
    match source {
        Some(source) => orchestrator.with_account_source(source),
        None => orchestrator,
    }
}

#[tokio::test]
async fn conta_nativa_entrega_itens_sem_rota_node() {
    let orch = orchestrator(false, Some(stub_inventory()), Duration::ZERO);
    let (items, _partial, completion, _failed, _live) = orch
        .collect_scoped(&input(), &meta(&["Matrix"], 1999, None, None), None)
        .await;
    let all = completion.expect("completion").await.expect("lote");
    assert!(items.iter().any(|item| item.from_account));
    assert!(all.iter().any(|item| item.from_account));
}

#[tokio::test]
async fn servico_desconhecido_nao_vira_fonte_nativa() {
    let orch = orchestrator(true, Some(stub_inventory()), Duration::ZERO);
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
}

#[tokio::test]
async fn fast_path_responde_antes_da_coleta_lenta() {
    let orch = orchestrator(true, Some(stub_inventory()), Duration::from_millis(300));
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
    let orch = orchestrator(false, Some(stub_inventory()), Duration::from_millis(150));
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
