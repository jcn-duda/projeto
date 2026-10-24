use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use super::*;
use crate::holds_feed::{
    holds_feed_enabled, timeout_from, InternalHoldsClient, DEFAULT_BASE, ENV, TIMEOUT_ENV,
};

// ── Cliente HTTP ────────────────────────────────────────────────────────────

#[derive(Default)]
struct Seen {
    token: Mutex<Vec<Option<String>>>,
    bodies: Mutex<Vec<Value>>,
    delay_ms: Mutex<u64>,
    status: Mutex<u16>,
}

async fn holds_route(State(seen): State<Arc<Seen>>, req: Request<Body>) -> Response {
    seen.token.lock().await.push(
        req.headers()
            .get("x-indexer-test-token")
            .and_then(|t| t.to_str().ok().map(str::to_string)),
    );
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
            "account": ACCOUNT,
            "inventoryLoaded": true,
            "knownBefore": [HIT],
            "heldHashes": [MISS],
            "evaluated": [HIT, MISS],
            "holdsComplete": true,
            "dropReady": true,
            "dropUncached": true,
        });
        (status, Json(payload)).into_response()
    } else {
        (status, Json(json!({ "ok": false, "error": "boom" }))).into_response()
    }
}

async fn serve(seen: Arc<Seen>) -> String {
    let app = Router::new()
        .route(super::super::PATH, post(holds_route))
        .with_state(seen);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn cliente_manda_token_no_header_e_encoded_no_corpo() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let client = InternalHoldsClient::new(&base, TOKEN, Duration::from_millis(2000)).unwrap();
    let parsed = client
        .fetch(
            ENCODED,
            "alldebrid",
            &[HIT.to_string(), MISS.to_string()],
            None,
        )
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
    assert!(body.get("apiKey").is_none(), "chave NÃO vai no corpo");
    assert!(parsed.covers(&[HIT.to_string(), MISS.to_string()]));
}

#[tokio::test]
async fn cliente_recusa_lote_vazio_e_host_nao_loopback() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen).await;
    let client = InternalHoldsClient::new(&base, TOKEN, Duration::from_millis(1000)).unwrap();
    assert!(client.fetch(ENCODED, "alldebrid", &[], None).await.is_err());
    assert!(InternalHoldsClient::new(
        "http://example.com:7100",
        TOKEN,
        Duration::from_millis(1000)
    )
    .is_err());
}

#[tokio::test]
async fn resposta_lenta_ou_erro_http_nao_viram_fatos() {
    let seen = Arc::new(Seen::default());
    *seen.delay_ms.lock().await = 500;
    let base = serve(seen.clone()).await;
    let client = InternalHoldsClient::new(&base, TOKEN, Duration::from_millis(50)).unwrap();
    assert!(
        client
            .fetch(ENCODED, "alldebrid", &[HIT.to_string()], None)
            .await
            .is_err(),
        "prazo estourado = sem fatos (read-only), nunca lista parcial"
    );

    *seen.delay_ms.lock().await = 0;
    *seen.status.lock().await = 503;
    let client = InternalHoldsClient::new(&base, TOKEN, Duration::from_millis(1000)).unwrap();
    assert!(client
        .fetch(ENCODED, "alldebrid", &[HIT.to_string()], None)
        .await
        .is_err());
}

/// `deadline_at` da busca limita o POST e deadline vencido nem abre HTTP.
#[tokio::test]
async fn deadline_da_busca_limita_o_feed() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let client = InternalHoldsClient::new(&base, TOKEN, Duration::from_millis(2000)).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let err = client
        .fetch(ENCODED, "alldebrid", &[HIT.to_string()], Some(now - 1))
        .await
        .unwrap_err();
    assert!(err.contains("deadline"), "{err}");
    assert!(
        seen.bodies.lock().await.is_empty(),
        "deadline vencido não abre HTTP"
    );
    // Deadline futuro e apertado: o teto do cliente não pode ser ignorado
    // (aqui a resposta é imediata, então o POST passa dentro do prazo).
    let parsed = client
        .fetch(ENCODED, "alldebrid", &[HIT.to_string()], Some(now + 5_000))
        .await
        .unwrap();
    assert!(parsed.covers(&[HIT.to_string()]));
}

// ── Flag ────────────────────────────────────────────────────────────────────

#[test]
fn flag_default_off_e_apelidos() {
    {
        let _env = EnvGuard::set(&[(ENV, None)]);
        assert!(!holds_feed_enabled());
        assert!(
            InternalHoldsClient::from_env().is_none(),
            "flag OFF não constrói cliente (custo zero)"
        );
    }
    for raw in ["on", "1", "true", "yes", "RUST"] {
        let _env = EnvGuard::set(&[(ENV, Some(raw))]);
        assert!(holds_feed_enabled(), "{raw}");
    }
    let _env = EnvGuard::set(&[(ENV, Some("off"))]);
    assert!(!holds_feed_enabled());
}

#[test]
fn from_env_exige_flag_token_e_loopback() {
    {
        let _env = EnvGuard::set(&[
            ("INTERNAL_CHECK_URL", Some("http://127.0.0.1:7100")),
            ("DEBRID_INTERNAL_TOKEN", Some(TOKEN)),
            ("JACKETT_TEST_TOKEN", None),
            (ENV, None),
        ]);
        assert!(InternalHoldsClient::from_env().is_none());
    }
    {
        let _env = EnvGuard::set(&[
            ("INTERNAL_CHECK_URL", Some("http://127.0.0.1:7100")),
            ("DEBRID_INTERNAL_TOKEN", Some(TOKEN)),
            ("JACKETT_TEST_TOKEN", None),
            (ENV, Some("on")),
        ]);
        assert!(InternalHoldsClient::from_env().is_some());
    }
    {
        let _env = EnvGuard::set(&[
            ("INTERNAL_CHECK_URL", Some("http://127.0.0.1:7100")),
            ("DEBRID_INTERNAL_TOKEN", None),
            ("JACKETT_TEST_TOKEN", None),
            (ENV, Some("on")),
        ]);
        assert!(
            InternalHoldsClient::from_env().is_none(),
            "sem token não há feed"
        );
    }
    {
        let _env = EnvGuard::set(&[
            ("INTERNAL_CHECK_URL", Some("http://203.0.113.9:7100")),
            ("DEBRID_INTERNAL_TOKEN", Some(TOKEN)),
            ("JACKETT_TEST_TOKEN", None),
            (ENV, Some("on")),
        ]);
        assert!(
            InternalHoldsClient::from_env().is_none(),
            "fora do loopback não há feed"
        );
    }
}

#[test]
fn a_base_default_e_a_porta_do_node_com_gateway() {
    assert_eq!(DEFAULT_BASE, "http://127.0.0.1:7100");
    // Sem `INTERNAL_CHECK_URL`, o feed herda o default — a 7000 é a fachada
    // Rust e recusa `/internal/*`.
    let _env = EnvGuard::set(&[
        ("INTERNAL_CHECK_URL", None),
        ("DEBRID_INTERNAL_TOKEN", Some(TOKEN)),
        ("JACKETT_TEST_TOKEN", None),
        (ENV, Some("on")),
    ]);
    assert!(InternalHoldsClient::from_env().is_some());
}

#[test]
fn timeout_da_rota_tem_default_e_minimo() {
    assert_eq!(timeout_from(None), Duration::from_millis(800));
    assert_eq!(timeout_from(Some("0")), Duration::from_millis(800));
    assert_eq!(timeout_from(Some("250")), Duration::from_millis(250));
    let _env = EnvGuard::set(&[(TIMEOUT_ENV, Some("120"))]);
    assert_eq!(
        timeout_from(std::env::var(TIMEOUT_ENV).ok().as_deref()),
        Duration::from_millis(120)
    );
}
