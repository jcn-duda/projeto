//! Testes do cliente de reserva: contrato Node (`encoded` + `deadline_at`),
//! token no header e o prazo duro (servidor lento vira erro, nunca veredito).

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Json;
use axum::Router;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use super::InternalCheckClient;

const TOKEN: &str = "token-interno";
const ENCODED: &str = "eyJwIjoiamFja2V0dCJ9";
const HIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[derive(Default)]
struct Seen {
    token: Mutex<Vec<Option<String>>>,
    bodies: Mutex<Vec<Value>>,
    delay_ms: Mutex<u64>,
    status: Mutex<u16>,
}

async fn check_route(State(seen): State<Arc<Seen>>, req: Request<Body>) -> Response {
    if let Some(token) = req.headers().get("x-indexer-test-token") {
        seen.token
            .lock()
            .await
            .push(Some(token.to_str().unwrap_or("").to_string()));
    } else {
        seen.token.lock().await.push(None);
    }
    let body = axum::body::to_bytes(req.into_body(), 1 << 20)
        .await
        .unwrap_or_default();
    if let Ok(value) = serde_json::from_slice::<Value>(&body) {
        seen.bodies.lock().await.push(value);
    }
    let delay = *seen.delay_ms.lock().await;
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    let status = StatusCode::from_u16(*seen.status.lock().await).unwrap_or(StatusCode::OK);
    if status.is_success() {
        let payload = json!({
            "ok": true,
            "service": "alldebrid",
            "configured": true,
            "partial": false,
            "results": {
                HIT: { "cached": true, "known": true }
            }
        });
        (status, Json(payload)).into_response()
    } else {
        (status, Json(json!({ "ok": false, "error": "boom" }))).into_response()
    }
}

async fn serve(seen: Arc<Seen>) -> String {
    let app = Router::new()
        .route("/internal/debrid/check", post(check_route))
        .with_state(seen);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

fn client(base: &str, timeout: Duration) -> InternalCheckClient {
    InternalCheckClient::new(base, TOKEN, timeout).unwrap()
}

fn deadline_in(ms: i64) -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + ms
}

#[tokio::test]
async fn carrega_token_no_header_e_parseia_veredito_node() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let outcome = client(&base, Duration::from_millis(2000))
        .check(ENCODED, "alldebrid", &[HIT.to_string()], deadline_in(5_000))
        .await
        .unwrap();
    assert_eq!(
        seen.token.lock().await.first().and_then(|t| t.as_deref()),
        Some(TOKEN),
        "o token vai SÓ no header"
    );
    let body = seen.bodies.lock().await.first().cloned().unwrap();
    assert_eq!(body["encoded"], json!(ENCODED));
    assert_eq!(body["service"], json!("alldebrid"));
    assert_eq!(body["hashes"][0], json!(HIT));
    assert!(body["deadline_at"].as_i64().unwrap() > 0);
    assert!(body.get("apiKey").is_none(), "chave NÃO vai no corpo");
    assert!(outcome.known);
    assert_eq!(outcome.cached.len(), 1);
}

#[tokio::test]
async fn prazo_estourado_vira_erro_nunca_veredito() {
    let seen = Arc::new(Seen::default());
    *seen.delay_ms.lock().await = 500;
    let base = serve(seen).await;
    let err = client(&base, Duration::from_millis(50))
        .check(ENCODED, "torbox", &[], deadline_in(5_000))
        .await
        .unwrap_err();
    assert!(!err.is_empty());
}

#[tokio::test]
async fn deadline_ja_vencido_sem_rede() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let err = client(&base, Duration::from_millis(1000))
        .check(ENCODED, "torbox", &[], deadline_in(-100))
        .await
        .unwrap_err();
    assert!(err.contains("deadline"));
    assert!(seen.bodies.lock().await.is_empty(), "não manda request");
}

#[tokio::test]
async fn http_erro_nao_vira_veredito() {
    let seen = Arc::new(Seen::default());
    *seen.status.lock().await = 503;
    let base = serve(seen).await;
    assert!(client(&base, Duration::from_millis(1000))
        .check(ENCODED, "premiumize", &[], deadline_in(5_000))
        .await
        .is_err());
}

#[test]
fn new_recusa_host_nao_loopback() {
    assert!(InternalCheckClient::new("http://example.com:7000", TOKEN, DEFAULT_TIMEOUT).is_err());
    assert!(InternalCheckClient::new("http://127.0.0.1:7000", TOKEN, DEFAULT_TIMEOUT).is_ok());
}

#[test]
fn parse_node_response_cached_known_e_unusable() {
    assert!(super::parse_node_response(&json!({ "cached": [] })).is_err());

    let parsed = super::parse_node_response(&json!({
        "ok": true,
        "service": "torbox",
        "configured": true,
        "partial": false,
        "results": {
            HIT: { "cached": true, "known": true },
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": { "cached": false, "known": true },
        }
    }))
    .unwrap();
    assert!(parsed.known);
    assert_eq!(parsed.cached, vec![HIT]);

    let timeout = super::parse_node_response(&json!({
        "ok": true,
        "configured": true,
        "partial": true,
        "results": {
            HIT: { "cached": false, "known": false, "timeout": true },
        }
    }))
    .unwrap();
    assert!(!timeout.known, "timeout NÃO é Missing");

    // Lote parcial: um hit + um timeout. AND do known zera o flag do lote,
    // mas o hash confirmado permanece em cached (⚡ no seam/Node).
    let partial_hit = super::parse_node_response(&json!({
        "ok": true,
        "configured": true,
        "partial": true,
        "results": {
            HIT: { "cached": true, "known": true },
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": {
                "cached": false, "known": false, "timeout": true
            },
        }
    }))
    .unwrap();
    assert!(!partial_hit.known, "AND do lote: um timeout → known:false");
    assert_eq!(
        partial_hit.cached,
        vec![HIT],
        "hit parcial NÃO some do cached"
    );

    let unusable = super::parse_node_response(&json!({
        "ok": true,
        "configured": true,
        "partial": true,
        "unusable": "auth",
        "results": {
            HIT: { "cached": false, "known": false, "unusable": "auth" },
        }
    }))
    .unwrap();
    assert_eq!(unusable.unusable.map(|(k, _)| k.as_str()), Some("auth"));

    let no_key = super::parse_node_response(&json!({
        "ok": true,
        "configured": false,
        "partial": false,
        "results": {}
    }))
    .unwrap();
    assert!(!no_key.known);
    assert!(no_key.cached.is_empty());
}

use super::DEFAULT_TIMEOUT;
