use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::routing::any;
use axum::Router;
use http::header::{CONNECTION, HOST};
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tokio::net::TcpListener;

use crate::config::{native_health, stream_native, stream_shadow, Config};
use crate::proxy::{self, AppState};
use crate::shadow::{self, ShadowMetrics, DIVERGENCE, DIVERGENCE_ITEMS};

#[derive(Clone)]
struct Hits(Arc<AtomicU32>);

async fn spawn_upstream() -> (SocketAddr, Hits) {
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

async fn echo(State(hits): State<Hits>, req: Request<Body>) -> Body {
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

async fn spawn_gateway_state(state: AppState) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, proxy::router(state)).await.unwrap();
    });
    addr
}

fn gateway_state(upstream: SocketAddr, native_health: bool, stream_shadow: bool) -> AppState {
    AppState {
        client: proxy::client(),
        upstream: format!("http://{upstream}").parse().unwrap(),
        native_health,
        stream_shadow,
        shadow_metrics: ShadowMetrics::new(),
    }
}

async fn spawn_gateway(upstream: SocketAddr, native_health: bool) -> SocketAddr {
    spawn_gateway_state(gateway_state(upstream, native_health, false)).await
}

async fn call(addr: SocketAddr, req: Request<Body>) -> (StatusCode, String) {
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
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
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
    // Ambos podem coexistir na CSV; o corte nativo ainda não liga.
    assert!(stream_shadow("stream,stream-shadow"));
    assert!(stream_native("stream,stream-shadow"));
}

#[test]
fn config_default_vazio_nao_liga_stream() {
    let ok = Config::parse("127.0.0.1:9", "http://127.0.0.1:7100", "").unwrap();
    assert!(!ok.native_health);
    assert!(!ok.stream_shadow);
    assert!(!ok.stream_native);
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

    // Stub sem remontador: divergence* permanece zero (não acusar falso +).
    tokio::task::yield_now().await;
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE_ITEMS), 0);

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

#[tokio::test]
async fn health_nativo_nao_toca_o_upstream() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway(upstream, true).await;
    let health = Request::builder()
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, health).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, r#"{"ok":true}"#);
    assert_eq!(hits.0.load(Ordering::SeqCst), 0);

    let manifest = Request::builder()
        .uri("/manifest.json")
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(gateway, manifest).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hits.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn upstream_morto_responde_502() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let gateway = spawn_gateway(SocketAddr::from(([127, 0, 0, 1], port)), false).await;
    let req = Request::builder()
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body, "bad_gateway");
}

#[test]
fn upstream_uri_preserva_query() {
    let base = "http://127.0.0.1:7100".parse().unwrap();
    let uri = proxy::upstream_uri(&base, "/stream/movie/x?y=1").unwrap();
    assert_eq!(uri.to_string(), "http://127.0.0.1:7100/stream/movie/x?y=1");
}

#[test]
fn config_rejeita_upstream_sem_host() {
    assert!(Config::parse("127.0.0.1:9", "http://", "").is_err());
    let ok = Config::parse("127.0.0.1:9", "http://127.0.0.1:7100", "health").unwrap();
    assert!(ok.native_health);
    assert!(!ok.stream_shadow);
    assert!(!ok.stream_native);

    let shadow = Config::parse(
        "127.0.0.1:9",
        "http://127.0.0.1:7100",
        "health,stream-shadow",
    )
    .unwrap();
    assert!(shadow.native_health);
    assert!(shadow.stream_shadow);
    assert!(!shadow.stream_native);

    let native = Config::parse("127.0.0.1:9", "http://127.0.0.1:7100", "stream").unwrap();
    assert!(!native.stream_shadow);
    assert!(native.stream_native);
}

#[test]
fn gateway_on_so_com_valor_exato() {
    assert!(crate::gateway_on("on"));
    assert!(!crate::gateway_on(""));
    assert!(!crate::gateway_on("off"));
    assert!(!crate::gateway_on("ON"));
}

#[test]
fn shadow_metrics_snapshot_expoe_chaves_zeradas() {
    let snap = ShadowMetrics::new().snapshot();
    assert_eq!(snap.get(DIVERGENCE), Some(&0));
    assert_eq!(snap.get(DIVERGENCE_ITEMS), Some(&0));
    assert_eq!(snap.get(shadow::COMPARED), Some(&0));
}
