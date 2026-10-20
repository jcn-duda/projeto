use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use adom_core::PlayHint;
use adom_debrid::play::PlayOutcome;
use adom_debrid::DebridError;
use axum::body::Body;
use axum::extract::State;
use axum::routing::any;
use axum::Router;
use http::header::{CONNECTION, HOST};
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tokio::net::TcpListener;

use adom_search::orchestrator::{Orchestrator, OrchestratorConfig};
use adom_search::MemorySwrStore;

use crate::canary::{Canary, SAMPLED};
use crate::config::{native_health, resolve_native, stream_native, stream_shadow, Config};
use crate::proxy::{self, AppState};
use crate::shadow::{self, ShadowMetrics, COMPARED, DIVERGENCE, DIVERGENCE_ITEMS};

#[derive(Clone)]
pub(super) struct Hits(Arc<AtomicU32>);

pub(super) async fn spawn_upstream() -> (SocketAddr, Hits) {
    let hits = Hits(Arc::new(AtomicU32::new(0)));
    let hits_state = hits.clone();
    let app = Router::new().fallback(any(echo)).with_state(hits_state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, hits)
}

/// Upstream que responde um `/stream` VÁLIDO (não o echo): alimenta o canário
/// direto, que compara o corpo do corte com esta lista.
pub(super) async fn spawn_stream_upstream() -> (SocketAddr, Hits) {
    async fn stream_handler(State(hits): State<Hits>) -> axum::Json<Value> {
        hits.0.fetch_add(1, Ordering::SeqCst);
        axum::Json(serde_json::json!({
            "streams": [{
                "name": "1080p",
                "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }],
            "cacheMaxAge": 900
        }))
    }
    let hits = Hits(Arc::new(AtomicU32::new(0)));
    let app = Router::new()
        .fallback(any(stream_handler))
        .with_state(hits.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, hits)
}

pub(super) async fn echo(State(hits): State<Hits>, req: Request<Body>) -> Body {
    hits.0.fetch_add(1, Ordering::SeqCst);
    let host = req
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let saw_connection = req.headers().contains_key(CONNECTION);
    let method = req.method().clone();
    let pq = req
        .uri()
        .path_and_query()
        .map(|item| item.as_str().to_string())
        .unwrap_or_default();
    let bytes = req.into_body().collect().await.unwrap().to_bytes();
    let payload = serde_json::json!({
        "method": method.as_str(),
        "pq": pq,
        "host": host,
        "connection": saw_connection,
        "body": String::from_utf8_lossy(&bytes),
    });
    Body::from(payload.to_string())
}

pub(super) async fn spawn_gateway_state(state: AppState) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, proxy::router(state)).await.unwrap();
    });
    addr
}

pub(super) fn gateway_state(
    upstream: SocketAddr,
    native_health: bool,
    stream_shadow: bool,
) -> AppState {
    AppState {
        client: proxy::client(),
        upstream: format!("http://{upstream}").parse().unwrap(),
        native_health,
        stream_shadow,
        stream_native: false,
        resolve_native: false,
        resolve_rust: false,
        resolve_proxy: true,
        resolve_secret: String::new(),
        resolver: Arc::new(crate::resolve_native::NoopResolver),
        shadow_metrics: ShadowMetrics::new(),
        orchestrator: None,
        shadow_remount: None,
        shadow_direct: false,
        canary: Canary::new(0),
    }
}

pub(super) fn stub_orchestrator() -> Orchestrator {
    // Collector default falha → lista/aviso 200, sem rede. Serve para provar
    // o corte sem Node no ar.
    Orchestrator::new(
        OrchestratorConfig::default(),
        Arc::new(MemorySwrStore::new()),
    )
}

pub(super) fn gateway_state_native(
    upstream: SocketAddr,
    stream_shadow: bool,
    orch: Orchestrator,
) -> AppState {
    AppState {
        client: proxy::client(),
        upstream: format!("http://{upstream}").parse().unwrap(),
        native_health: false,
        stream_shadow,
        stream_native: true,
        resolve_native: false,
        resolve_rust: false,
        resolve_proxy: true,
        resolve_secret: String::new(),
        resolver: Arc::new(crate::resolve_native::NoopResolver),
        shadow_metrics: ShadowMetrics::new(),
        orchestrator: Some(orch),
        // Com corte nativo a sombra do Node não monta.
        shadow_remount: None,
        shadow_direct: false,
        canary: Canary::new(0),
    }
}

pub(super) fn gateway_state_resolve(
    upstream: SocketAddr,
    secret: &str,
    proxy_enabled: bool,
) -> AppState {
    AppState {
        client: proxy::client(),
        upstream: format!("http://{upstream}").parse().unwrap(),
        native_health: false,
        stream_shadow: false,
        stream_native: false,
        resolve_native: true,
        resolve_rust: false,
        resolve_proxy: proxy_enabled,
        resolve_secret: secret.to_string(),
        resolver: Arc::new(crate::resolve_native::NoopResolver),
        shadow_metrics: ShadowMetrics::new(),
        orchestrator: None,
        shadow_remount: None,
        shadow_direct: false,
        canary: Canary::new(0),
    }
}

/// Estado com o play NATIVO ligado (`RESOLVE_RUST=on`) e o resolvedor injetado.
pub(super) fn gateway_state_resolve_rust(
    upstream: SocketAddr,
    secret: &str,
    resolver: Arc<dyn crate::resolve_native::PlayResolver>,
) -> AppState {
    let mut state = gateway_state_resolve(upstream, secret, true);
    state.resolve_rust = true;
    state.resolver = resolver;
    state
}

pub(super) async fn spawn_gateway(upstream: SocketAddr, native_health: bool) -> SocketAddr {
    spawn_gateway_state(gateway_state(upstream, native_health, false)).await
}

pub(super) async fn call(addr: SocketAddr, req: Request<Body>) -> (StatusCode, String) {
    let (status, _headers, body) = call_full(addr, req).await;
    (status, body)
}

/// Como [`call`], mas devolve os headers (o `/resolve` nativo precisa do
/// `Location` do 302).
pub(super) async fn call_full(
    addr: SocketAddr,
    req: Request<Body>,
) -> (StatusCode, http::HeaderMap, String) {
    let client = proxy::client();
    let (mut parts, body) = req.into_parts();
    let pq = parts
        .uri
        .path_and_query()
        .map(|item| item.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    parts.uri = format!("http://{addr}{pq}").parse().unwrap();
    let response = client
        .request(Request::from_parts(parts, body))
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        headers,
        String::from_utf8_lossy(&bytes).into_owned(),
    )
}

/// Resolvedor de teste: devolve o `Result` fixo e conta as chamadas.
pub(super) struct StubResolver {
    outcome: Result<PlayOutcome, DebridError>,
    pub calls: AtomicU32,
    pub seen: Mutex<Vec<(String, String, PlayHint)>>,
}

impl StubResolver {
    pub(super) fn ok(url: &str) -> Arc<Self> {
        Self::with(Ok(PlayOutcome {
            url: Some(url.into()),
            ..PlayOutcome::default()
        }))
    }

    pub(super) fn err(error: DebridError) -> Arc<Self> {
        Self::with(Err(error))
    }

    fn with(outcome: Result<PlayOutcome, DebridError>) -> Arc<Self> {
        Arc::new(Self {
            outcome,
            calls: AtomicU32::new(0),
            seen: Mutex::new(Vec::new()),
        })
    }
}

impl crate::resolve_native::PlayResolver for StubResolver {
    fn resolve<'a>(
        &'a self,
        service: &'a str,
        api_key: &'a str,
        _info_hash: &'a str,
        hint: &'a PlayHint,
    ) -> Pin<Box<dyn Future<Output = Result<PlayOutcome, DebridError>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.seen
            .lock()
            .unwrap()
            .push((service.to_string(), api_key.to_string(), hint.clone()));
        let outcome = self.outcome.clone();
        Box::pin(async move { outcome })
    }
}

#[test]
fn health_so_com_token_exato() {
    assert!(!native_health(""));
    assert!(!native_health(" Health "));
    assert!(native_health("health"));
    assert!(native_health(" manifest , health "));
}

#[test]
fn stream_shadow_e_stream_parseados_sem_confundir() {
    assert!(!stream_shadow(""));
    assert!(!stream_shadow("stream"));
    assert!(!stream_shadow(" Stream-Shadow "));
    assert!(stream_shadow("stream-shadow"));
    assert!(stream_shadow("health,stream-shadow"));
    assert!(stream_shadow(" stream-shadow , health "));

    assert!(!stream_native(""));
    assert!(!stream_native("stream-shadow"));
    assert!(stream_native("stream"));
    assert!(stream_native("health,stream"));
    // Ambos podem coexistir; o dispatch nativo tem prioridade sobre a sombra.
    assert!(stream_shadow("stream,stream-shadow"));
    assert!(stream_native("stream,stream-shadow"));

    assert!(!resolve_native(""));
    assert!(!resolve_native("stream"));
    assert!(resolve_native("resolve"));
    assert!(resolve_native("health,resolve,stream"));
}

#[test]
fn config_default_vazio_nao_liga_stream() {
    let ok = Config::parse(
        "127.0.0.1:9",
        "http://127.0.0.1:7100",
        "",
        false,
        true,
        String::new(),
    )
    .unwrap();
    assert!(!ok.native_health);
    assert!(!ok.stream_shadow);
    assert!(!ok.stream_native);
    assert!(!ok.resolve_native);
    assert!(!ok.resolve_rust);
    assert!(ok.resolve_proxy);
}

#[test]
fn is_stream_path_aceita_com_e_sem_config() {
    assert!(shadow::is_stream_path("/stream/movie/tt0133093.json"));
    assert!(shadow::is_stream_path(
        "/eyJwIjoiamFja2V0dCJ9/stream/series/tt0903747:5:14.json"
    ));
    assert!(!shadow::is_stream_path("/stream/movie"));
    assert!(!shadow::is_stream_path("/stream/movie/tt1"));
    assert!(!shadow::is_stream_path("/health"));
    assert!(!shadow::is_stream_path("/manifest.json"));
}

#[tokio::test]
async fn proxy_repassa_corpo_query_e_host() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway(upstream, false).await;
    let req = Request::builder()
        .method("POST")
        .uri("/filme?ano=2024")
        .header(HOST, "publico.example")
        .header(CONNECTION, "close")
        .header("x-marca", "adom")
        .body(Body::from("abc"))
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["method"], "POST");
    assert_eq!(json["pq"], "/filme?ano=2024");
    assert_eq!(json["host"], "publico.example");
    assert_eq!(json["connection"], false);
    assert_eq!(json["body"], "abc");
    assert_eq!(hits.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn gateway_recusa_internal_sem_tocar_o_upstream() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway(upstream, false).await;
    for path in [
        "/internal",
        "/internal/",
        "/internal/search/meta",
        "/internal/search/state?x=1",
    ] {
        let req = Request::builder()
            .method("POST")
            .uri(path)
            .body(Body::from("{}"))
            .unwrap();
        let (status, body) = call(gateway, req).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "caminho {path}");
        assert!(body.contains("rota interna"), "corpo: {body}");
    }
    assert_eq!(
        hits.0.load(Ordering::SeqCst),
        0,
        "nenhum /internal chega ao Node"
    );
    // Um caminho que só COMEÇA com a palavra não é a superfície interna.
    let req = Request::builder()
        .uri("/internalfoo")
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(gateway, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hits.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stream_shadow_ainda_devolve_o_upstream_e_internal_continua_recusado() {
    let (upstream, hits) = spawn_upstream().await;
    let state = gateway_state(upstream, false, true);
    let metrics = state.shadow_metrics.clone();
    let gateway = spawn_gateway_state(state).await;

    let req = Request::builder()
        .uri("/stream/movie/tt0133093.json")
        .header(HOST, "publico.example")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["method"], "GET");
    assert_eq!(json["pq"], "/stream/movie/tt0133093.json");
    assert_eq!(json["host"], "publico.example");
    assert_eq!(hits.0.load(Ordering::SeqCst), 1);

    // Sem shadow_remount (token/env): observe pula — zero compared/divergence.
    tokio::task::yield_now().await;
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE_ITEMS), 0);

    let metrics_req = Request::builder()
        .uri("/metrics")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, metrics_req).await;
    assert_eq!(status, StatusCode::OK);
    let snap: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(snap[COMPARED], 0);
    assert_eq!(snap[DIVERGENCE], 0);
    // Snapshot não vaza token/credencial — só contadores §9.
    assert!(snap.get("token").is_none());

    let forbidden = Request::builder()
        .uri("/internal/search/meta")
        .body(Body::from("{}"))
        .unwrap();
    let (status, body) = call(gateway, forbidden).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains("rota interna"));
    assert_eq!(hits.0.load(Ordering::SeqCst), 1);
}

#[test]
fn internal_path_reconhece_exato_e_subcaminho() {
    assert!(proxy::is_internal_path("/internal"));
    assert!(proxy::is_internal_path("/internal/"));
    assert!(proxy::is_internal_path("/internal/search/meta"));
    assert!(!proxy::is_internal_path("/internalfoo"));
    assert!(!proxy::is_internal_path("/internal-search"));
    assert!(!proxy::is_internal_path("/health"));
}

#[path = "tests_routes.rs"]
mod tests_routes;
