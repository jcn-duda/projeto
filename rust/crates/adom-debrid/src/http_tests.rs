use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::routing::any;
use axum::Router;
use reqwest::Method;
use tokio::net::TcpListener;

use super::{Call, HttpClient};

#[derive(Clone)]
struct Hit {
    done: Arc<AtomicU32>,
    status: u16,
    body: String,
    delay: Duration,
    retry_after: Option<String>,
}

async fn listen(hit: Hit) -> std::net::SocketAddr {
    let app = Router::new().fallback(any(respond)).with_state(hit);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

async fn respond(State(hit): State<Hit>) -> impl axum::response::IntoResponse {
    if !hit.delay.is_zero() {
        tokio::time::sleep(hit.delay).await;
    }
    hit.done.fetch_add(1, Ordering::SeqCst);
    let mut headers = axum::http::HeaderMap::new();
    if let Some(retry) = &hit.retry_after {
        if let Ok(value) = axum::http::HeaderValue::from_str(retry) {
            headers.insert("retry-after", value);
        }
    }
    (
        axum::http::StatusCode::from_u16(hit.status).unwrap_or(axum::http::StatusCode::OK),
        headers,
        hit.body,
    )
}

fn call(url: String, timeout: Duration, abort_safe: bool) -> Call {
    Call {
        method: Method::GET,
        url,
        headers: Vec::new(),
        body: None,
        timeout,
        abort_safe,
    }
}

#[tokio::test]
async fn classifica_status_http() {
    let client = HttpClient::new().unwrap();
    let cases = [
        (401, "nope", None, "auth"),
        (403, "nope", None, "auth"),
        (451, "blocked", None, "blocked"),
        (500, "MAGNET_TOO_MANY_ACTIVE", None, "quota"),
    ];
    for (status, body, retry, kind) in cases {
        let addr = listen(Hit {
            done: Arc::new(AtomicU32::new(0)),
            status,
            body: body.to_string(),
            delay: Duration::ZERO,
            retry_after: retry.map(str::to_string),
        })
        .await;
        let err = client
            .json(call(
                format!("http://{addr}/x"),
                Duration::from_secs(2),
                false,
            ))
            .await
            .unwrap_err();
        assert_eq!(err.kind(), kind, "status {status}");
    }
}

#[tokio::test]
async fn rate_limit_le_retry_after() {
    let client = HttpClient::new().unwrap();
    let addr = listen(Hit {
        done: Arc::new(AtomicU32::new(0)),
        status: 429,
        body: "slow".into(),
        delay: Duration::ZERO,
        retry_after: Some("1.5".into()),
    })
    .await;
    let err = client
        .json(call(
            format!("http://{addr}/x"),
            Duration::from_secs(2),
            false,
        ))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "rate_limit");
    assert_eq!(err.retry_after_ms(), Some(1500));
}

#[tokio::test]
async fn status_204_e_json_200() {
    let client = HttpClient::new().unwrap();
    let empty = listen(Hit {
        done: Arc::new(AtomicU32::new(0)),
        status: 204,
        body: String::new(),
        delay: Duration::ZERO,
        retry_after: None,
    })
    .await;
    let none = client
        .json(call(
            format!("http://{empty}/x"),
            Duration::from_secs(2),
            false,
        ))
        .await
        .unwrap();
    assert!(none.is_none());

    let ok = listen(Hit {
        done: Arc::new(AtomicU32::new(0)),
        status: 200,
        body: r#"{"cached":true}"#.into(),
        delay: Duration::ZERO,
        retry_after: None,
    })
    .await;
    let value = client
        .json(call(
            format!("http://{ok}/x"),
            Duration::from_secs(2),
            false,
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(value["cached"], true);
}

#[tokio::test]
async fn prazo_curto_nao_espera_o_servidor() {
    let client = HttpClient::new().unwrap();
    let addr = listen(Hit {
        done: Arc::new(AtomicU32::new(0)),
        status: 200,
        body: "{}".into(),
        delay: Duration::from_secs(2),
        retry_after: None,
    })
    .await;
    let started = std::time::Instant::now();
    let err = client
        .json(call(
            format!("http://{addr}/x"),
            Duration::from_millis(80),
            false,
        ))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "other");
    assert!(started.elapsed() < Duration::from_millis(1500));
}

#[tokio::test]
async fn abort_safe_completa_depois_do_drop() {
    let client = HttpClient::new().unwrap();
    let done = Arc::new(AtomicU32::new(0));
    let addr = listen(Hit {
        done: done.clone(),
        status: 200,
        body: "{}".into(),
        delay: Duration::from_millis(200),
        retry_after: None,
    })
    .await;
    let driver = tokio::spawn(async move {
        let pending = client.json(call(
            format!("http://{addr}/upload"),
            Duration::from_secs(2),
            true,
        ));
        tokio::pin!(pending);
        tokio::select! {
            _ = pending => {}
            _ = tokio::time::sleep(Duration::from_millis(30)) => {}
        }
    });
    driver.await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(done.load(Ordering::SeqCst), 1);
}
