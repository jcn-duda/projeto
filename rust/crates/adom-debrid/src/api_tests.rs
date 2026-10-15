use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;

use super::{router, InternalConfig};

fn cfg(token: &str) -> InternalConfig {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("debrid.db");
    // O tempdir precisa sobreviver ao router: vaza de propósito neste teste.
    std::mem::forget(dir);
    InternalConfig {
        listen: "127.0.0.1:0".parse().unwrap(),
        token: token.to_string(),
        debrid_db: path,
        cache_db: PathBuf::from("data/cache.db.ausente"),
        import: false,
    }
}

async fn call(token: &str, header: Option<&str>, body: &str) -> (StatusCode, String) {
    let app = router(&cfg(token));
    let mut builder = Request::builder()
        .method("POST")
        .uri("/debrid/check")
        .header("content-type", "application/json");
    if let Some(value) = header {
        builder = builder.header("x-indexer-test-token", value);
    }
    let response = app
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn sem_token_configurado_responde_503() {
    let (status, body) = call("", Some("qualquer"), r#"{"service":"premiumize"}"#).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("debrid_internal_disabled"));
}

#[tokio::test]
async fn token_errado_responde_401() {
    let (status, _) = call("segredo", Some("outro"), r#"{"service":"premiumize"}"#).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn query_token_nao_autentica() {
    let app = router(&cfg("segredo"));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/debrid/check?token=segredo")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"service":"premiumize"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn servico_conhecido_ainda_nao_portado() {
    let (status, body) = call(
        "segredo",
        Some("segredo"),
        r#"{"service":"premiumize","apiKey":"nao-logar","hashes":["abc"]}"#,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert!(body.contains("service_not_ported"));
    assert!(!body.contains("nao-logar"));
}

#[test]
fn escuta_fora_do_loopback_e_recusada() {
    assert!(super::parse_listen("0.0.0.0:8710").is_err());
    assert!(super::parse_listen("127.0.0.1:8710").is_ok());
}
