//! Rota `/debrid/sweep-dead` sem rede: só as recusas que decidem antes do
//! cliente HTTP (JSON ruim, chave ausente, serviço não portado, serviço
//! desconhecido).

use axum::http::StatusCode;

use super::api_test_support::call;

const TOKEN: &str = "tok-sweep";
const PATH: &str = "/debrid/sweep-dead";

#[tokio::test]
async fn json_invalido_vira_400() {
    let (status, body) = call(TOKEN, Some(TOKEN), PATH, "{nao-json").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("bad_request"));
}

#[tokio::test]
async fn sem_api_key_vira_400() {
    let (status, _) = call(TOKEN, Some(TOKEN), PATH, r#"{"service":"premiumize"}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn torbox_vira_501_not_ported() {
    let body = r#"{"service":"torbox","apiKey":"nao-logar"}"#;
    let (status, text) = call(TOKEN, Some(TOKEN), PATH, body).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert!(text.contains("not_ported"));
    assert!(!text.contains("nao-logar"));
}

#[tokio::test]
async fn servico_desconhecido_vira_400() {
    let body = r#"{"service":"inventado","apiKey":"nao-logar"}"#;
    let (status, text) = call(TOKEN, Some(TOKEN), PATH, body).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(text.contains("unknown_service"));
}
