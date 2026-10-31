//! Rotas do catálogo: as três guardas das destrutivas (na ordem), e o gate da
//! conta. Nenhum teste aqui lê o env da conta: o gate é testado como função
//! pura, e as guardas rodam antes dele.

use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use adom_store::StreamsStore;

use super::{operator_account_on, refusal};

#[test]
fn allow_env_key_ausente_liga_como_no_ts() {
    assert!(operator_account_on(None, None));
    assert!(operator_account_on(Some(""), None));
    assert!(operator_account_on(Some("true"), None));
    assert!(!operator_account_on(Some("false"), None));
    assert!(!operator_account_on(Some("false"), Some("false")));
    assert!(operator_account_on(Some("false"), Some("true")));
}

use crate::store_admin::AdminConfig;

const TOKEN: &str = "token-de-teste";
const DESTRUTIVO: &str = "token-destrutivo";

/// Sobe o roteador admin real (com as rotas do catálogo) e devolve o endereço.
async fn spawn(destructive: Option<&str>) -> std::net::SocketAddr {
    let cfg = AdminConfig {
        listen: crate::store_admin::DEFAULT_LISTEN.parse().unwrap(),
        token: TOKEN.to_string(),
        destructive_token: destructive.map(str::to_string),
    };
    let store = Arc::new(StreamsStore::open_memory_with_quota(8).unwrap());
    let app = crate::store_admin::router_with_ownership(
        &cfg,
        store,
        300,
        None,
        None,
        None,
        crate::ownership_admin::router(),
        None,
        None,
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

async fn call(addr: std::net::SocketAddr, req: Request<Body>) -> (StatusCode, Value) {
    let client = crate::proxy::client();
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
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

/// POST com o token de diagnóstico (`X-Indexer-Test-Token`) e, opcional, a
/// credencial destrutiva no MESMO header (como as outras rotas admin).
fn post(path: &str, body: Value, header_token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header("x-indexer-test-token", header_token)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

const DESTRUTIVAS: [&str; 3] = [
    "/account-catalog/dedup-apply",
    "/account-catalog/manual-delete",
    "/account-catalog/cleanup-apply",
];

#[tokio::test]
async fn destrutivas_sem_credencial_configurada_respondem_409() {
    let addr = spawn(None).await;
    for path in DESTRUTIVAS {
        // Mesmo com `confirm:true`, a recusa de configuração vem ANTES.
        let (status, body) = call(addr, post(path, json!({ "confirm": true }), TOKEN)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{path}: {body}");
        assert_eq!(body["error"], "catalog_requires_admin_token", "{path}");
    }
}

#[tokio::test]
async fn token_de_diagnostico_nao_apaga_responde_403() {
    let addr = spawn(Some(DESTRUTIVO)).await;
    for path in DESTRUTIVAS {
        let (status, body) = call(addr, post(path, json!({ "confirm": true }), TOKEN)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
        assert_eq!(body["error"], "catalog_token_insufficient", "{path}");
    }
}

#[tokio::test]
async fn destrutiva_sem_confirm_responde_400_so_com_literal_true() {
    // A credencial destrutiva é a MESMA do header (passa o auth global e a guarda).
    let addr = spawn(Some(TOKEN)).await;
    for body in [
        json!({}),
        json!({ "confirm": false }),
        json!({ "confirm": "true" }),
    ] {
        for path in DESTRUTIVAS {
            let (status, reply) = call(addr, post(path, body.clone(), TOKEN)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path} {body}: {reply}");
            assert_eq!(reply["error"], "confirm_required", "{path} {body}");
        }
    }
}

#[tokio::test]
async fn corpo_invalido_na_destrutiva_nao_passa_da_guarda_de_confirm() {
    let addr = spawn(Some(TOKEN)).await;
    let req = Request::builder()
        .method("POST")
        .uri("/account-catalog/dedup-apply")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::from("nao-e-json"))
        .unwrap();
    let (status, reply) = call(addr, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{reply}");
    assert_eq!(reply["error"], "confirm_required");
}

#[tokio::test]
async fn token_global_errado_cai_no_401_antes_das_rotas() {
    let addr = spawn(Some(DESTRUTIVO)).await;
    let (status, _) = call(
        addr,
        post(
            "/account-catalog/cleanup-apply",
            json!({ "confirm": true }),
            "errado",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[test]
fn gate_recusa_na_ordem_do_catalog_context() {
    assert_eq!(refusal("", "k", true).unwrap()["reason"], "sem-debrid");
    assert_eq!(
        refusal("torbox", "k", true).unwrap()["reason"],
        "sem-adapter-catalogo"
    );
    assert_eq!(
        refusal("alldebrid", "", true).unwrap()["reason"],
        "sem-conta-operador"
    );
    let off = refusal("alldebrid", "k", false).unwrap();
    assert_eq!(off["reason"], "chave-operador-desativada");
    let hint = off["hint"].as_str().unwrap();
    assert!(hint.contains("DEBRID_OPERATOR_ENV_ACCOUNT"), "{hint}");
    assert!(hint.contains("DEBRID_ALLOW_ENV_KEY"), "{hint}");
    assert!(refusal("alldebrid", "k", true).is_none());
}

#[test]
fn gate_nunca_ecoa_a_chave() {
    let segredo = "segredo-da-conta-123";
    for (service, on) in [("", true), ("torbox", true), ("alldebrid", false)] {
        let text = refusal(service, segredo, on).unwrap().to_string();
        assert!(!text.contains(segredo), "{text}");
    }
}
