use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use tokio::net::TcpListener;
use tower::ServiceExt;

use super::api_test_support::{call, cfg, EnvBase, EnvVars, KEY};
use super::router;

/// AllDebrid falso: todo upload responde `ready` para o hash pedido.
async fn fake_alldebrid(req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let _ = req.into_body().collect().await;
    if path.ends_with("/magnet/upload") {
        return (
            StatusCode::OK,
            r#"{"status":"success","data":{"magnets":[{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ready":true,"id":7}]}}"#,
        )
            .into_response();
    }
    (StatusCode::OK, r#"{"status":"success","data":{}}"#).into_response()
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
    let _env = EnvBase::set("PREMIUMIZE_API_BASE", &base);
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
async fn torbox_e_alldebrid_respondem_no_http_sem_vazar_chave() {
    // TorBox e AllDebrid: mock em loopback (NUNCA a base real) → upstream 500
    // vira veredito known:false, sem "service_not_ported".
    let app = Router::new().fallback(any(async |_req: Request<Body>| {
        (StatusCode::INTERNAL_SERVER_ERROR, "fora do ar").into_response()
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let base = format!("http://{addr}");
    let _env = EnvVars::set(&[("TORBOX_API_BASE", &base), ("ALLDEBRID_API_BASE", &base)]);
    let torbox_body = format!(r#"{{"service":"torbox","apiKey":"{KEY}","hashes":["abc"]}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/check", &torbox_body).await;
    assert_eq!(status, StatusCode::OK, "torbox: {body}");
    assert!(!body.contains("service_not_ported"));
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["known"].as_bool(), Some(false));
    assert_eq!(json["unusable"], serde_json::Value::Null);
    // `blocked` é transporte: sempre presente, vazio nos serviços sem `adrm`.
    assert_eq!(json["blocked"], serde_json::json!([]));

    let ad_body = format!(r#"{{"service":"alldebrid","apiKey":"{KEY}","hashes":["abc"]}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/check", &ad_body).await;
    assert_eq!(status, StatusCode::OK, "alldebrid: {body}");
    assert!(!body.contains("service_not_ported"));
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["known"].as_bool(), Some(false));
    assert_eq!(
        json["blocked"],
        serde_json::json!([]),
        "erro sem filtro não gera blocked"
    );
}

#[tokio::test]
async fn alldebrid_check_nativo_sem_vazar_chave() {
    let app = Router::new().fallback(any(fake_alldebrid));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let base = format!("http://{addr}");
    let _env = EnvVars::set(&[("ALLDEBRID_API_BASE", &base)]);
    let body = format!(
        r#"{{"service":"alldebrid","apiKey":"{KEY}","hashes":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"timeoutMs":2000}}"#
    );
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/check", &body).await;
    assert_eq!(status, StatusCode::OK, "allDebrid nativo: {raw}");
    assert!(!raw.contains(KEY), "a chave não pode voltar no corpo");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        json["cached"][0].as_str(),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(json["complete"].as_bool(), Some(true));
    assert_eq!(json["known"].as_bool(), Some(true));
    assert_eq!(json["unusable"], serde_json::Value::Null);
    assert!(
        json["blocked"].is_array(),
        "blocked sempre presente no outcome"
    );
}

#[tokio::test]
async fn alldebrid_check_nativo_sem_chave_e_unknown() {
    let body = r#"{"service":"alldebrid","apiKey":"","hashes":["abc"]}"#;
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/check", body).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["known"].as_bool(), Some(false));
    assert_eq!(json["complete"].as_bool(), Some(false));
    assert_eq!(
        json["blocked"],
        serde_json::json!([]),
        "sem chave não há hash filtrado"
    );
}

#[tokio::test]
async fn debridlink_check_vazio_e_rotas_sem_metodo_ficam_501() {
    let body = format!(r#"{{"service":"debridlink","apiKey":"{KEY}","hashes":["abc"]}}"#);
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/check", &body).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!raw.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["cached"].as_array().map(|rows| rows.len()), Some(0));
    // `cacheCheck=false` no Node: vazio é "não sei", nunca "nada em cache".
    assert_eq!(json["complete"].as_bool(), Some(false));
    assert_eq!(json["known"].as_bool(), Some(false));

    // Real-Debrid: sem entrada no ledger → known:false, nunca "nada em cache".
    let (status, raw) = call(
        "segredo",
        Some("segredo"),
        "/debrid/check",
        r#"{"service":"realdebrid","apiKey":"nao-logar","hashes":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!raw.contains("service_not_ported"));
    assert!(!raw.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["known"].as_bool(), Some(false));

    // Debrid-Link não tem `accountStatus` no TS: essas DUAS rotas seguem 501.
    // AllDebrid/TorBox na conta têm teste próprio (`api_account_tests`).
    for path in ["/debrid/account", "/debrid/files"] {
        let (status, raw) = call("segredo", Some("segredo"), path, &body).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{path}: {raw}");
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

#[path = "api_tests_part2.rs"]
mod part2;
