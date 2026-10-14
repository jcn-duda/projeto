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

use crate::config::{native_health, Config};
use crate::proxy::{self, AppState};

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

async fn spawn_gateway(upstream: SocketAddr, native_health: bool) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = AppState {
        client: proxy::client(),
        upstream: format!("http://{upstream}").parse().unwrap(),
        native_health,
    };
    tokio::spawn(async move {
        axum::serve(listener, proxy::router(state)).await.unwrap();
    });
    addr
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
}
