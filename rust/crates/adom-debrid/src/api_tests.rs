use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use tokio::net::TcpListener;
use tower::ServiceExt;

use super::{router, InternalConfig};

const KEY: &str = "nao-logar";

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

async fn call(token: &str, header: Option<&str>, path: &str, body: &str) -> (StatusCode, String) {
    let app = router(&cfg(token));
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
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

struct EnvBase {
    prev: Option<String>,
}

impl EnvBase {
    fn set(value: &str) -> Self {
        let prev = std::env::var("PREMIUMIZE_API_BASE").ok();
        // SAFETY: o teste restaura no Drop. A base só aponta o adaptador ao loopback.
        unsafe { std::env::set_var("PREMIUMIZE_API_BASE", value) }
        Self { prev }
    }
}

impl Drop for EnvBase {
    fn drop(&mut self) {
        unsafe {
            match &self.prev {
                Some(value) => std::env::set_var("PREMIUMIZE_API_BASE", value),
                None => std::env::remove_var("PREMIUMIZE_API_BASE"),
            }
        }
    }
}

async fn local_premiumize() -> String {
    let app = Router::new().fallback(any(fake_premiumize));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

async fn fake_premiumize(req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let _ = req.into_body().collect().await;
    if path.ends_with("/cache/check") {
        return (
            StatusCode::OK,
            r#"{"status":"success","response":[true],"filesize":[4]}"#,
        )
            .into_response();
    }
    if path.ends_with("/transfer/directdl") {
        return (
            StatusCode::OK,
            r#"{"status":"success","content":[{"path":"leia.txt","size":4,"link":"http://127.0.0.1/x"}]}"#,
        )
            .into_response();
    }
    if path.ends_with("/account/info") {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("falha {KEY}")).into_response();
    }
    (StatusCode::NOT_FOUND, "ausente").into_response()
}

#[tokio::test]
async fn sem_token_configurado_responde_503() {
    let (status, body) = call(
        "",
        Some("qualquer"),
        "/debrid/check",
        r#"{"service":"premiumize"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("debrid_internal_disabled"));
}

#[tokio::test]
async fn token_errado_responde_401() {
    let (status, _) = call(
        "segredo",
        Some("outro"),
        "/debrid/check",
        r#"{"service":"premiumize"}"#,
    )
    .await;
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
async fn premiumize_no_loopback_nao_devolve_501() {
    let base = local_premiumize().await;
    let _env = EnvBase::set(&base);
    let check_body =
        format!(r#"{{"service":"premiumize","apiKey":"{KEY}","hashes":["abc"],"timeoutMs":2000}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/check", &check_body).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.contains("service_not_ported"));
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["complete"].as_bool(), Some(true));
    assert_eq!(json["cached"][0].as_str(), Some("abc"));

    let link_body = format!(
        r#"{{"service":"premiumize","apiKey":"{KEY}","hash":"abc","episode":{{"season":1,"episode":2,"work":{{"names":["Obra"],"year":2020,"pack":false}}}}}}"#
    );
    let (status, body) = call("segredo", Some("segredo"), "/debrid/link", &link_body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["error"].as_str(), Some("no_video"));
    assert_eq!(json["kind"].as_str(), Some("no_video"));
    assert!(json["message"].is_string());

    let files_body =
        format!(r#"{{"service":"premiumize","apiKey":"{KEY}","hash":"abc","path":"filme.mkv"}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/files", &files_body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.trim(), "null");
    assert!(!body.contains(KEY));

    let account_body = format!(r#"{{"service":"premiumize","apiKey":"{KEY}"}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/account", &account_body).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!body.contains("service_not_ported"));
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["kind"].as_str(), Some("other"));
    assert!(json["message"].is_string());
}

#[tokio::test]
async fn torbox_e_alldebrid_check_continuam_501() {
    for service in ["torbox", "alldebrid"] {
        let payload = format!(r#"{{"service":"{service}","apiKey":"{KEY}","hashes":["abc"]}}"#);
        let (status, body) = call("segredo", Some("segredo"), "/debrid/check", &payload).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
        assert!(body.contains("service_not_ported"));
        assert!(!body.contains(KEY));
    }
}

#[tokio::test]
async fn debridlink_check_vazio_e_rotas_sem_metodo_ficam_501() {
    let body = format!(r#"{{"service":"debridlink","apiKey":"{KEY}","hashes":["abc"]}}"#);
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/check", &body).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!raw.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["cached"].as_array().map(|rows| rows.len()), Some(0));
    assert_eq!(json["complete"].as_bool(), Some(true));

    let (status, raw) = call(
        "segredo",
        Some("segredo"),
        "/debrid/check",
        r#"{"service":"realdebrid","apiKey":"nao-logar"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert!(raw.contains("service_not_ported"));
    assert!(!raw.contains(KEY));

    for path in ["/debrid/account", "/debrid/files"] {
        let (status, raw) = call("segredo", Some("segredo"), path, &body).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
        assert!(raw.contains("service_not_ported"));
        assert!(!raw.contains(KEY));
    }

    let (status, raw) = call(
        "segredo",
        Some("segredo"),
        "/debrid/check",
        r#"{"service":"outro"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(raw.contains("unknown_service"));
}

#[test]
fn escuta_fora_do_loopback_e_recusada() {
    assert!(super::parse_listen("0.0.0.0:8710").is_err());
    assert!(super::parse_listen("127.0.0.1:8710").is_ok());
}
