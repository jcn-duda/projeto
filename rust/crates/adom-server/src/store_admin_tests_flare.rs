//! Testes da rota `GET /flare/busy` (stub documentado da Fase 2.2): token
//! obrigatório (a camada `auth` cobre a rota como as irmãs) e forma estável
//! `{"busy": bool}` — o contrato que a ponte do sidecar
//! (`adom-crawl::gate::flare_signal`) consome.

use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use serde_json::json;

use adom_store::StreamsStore;

use super::{call, spawn, TOKEN};

/// Token cobre a rota e a forma é exatamente `{"busy": false}` (stub: o
/// gateway não tem pedido de FlareSolverr em voo para reportar; ver handler
/// em `store_admin.rs`).
#[tokio::test]
async fn flare_busy_exige_token_e_devolve_busy_false() {
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let addr = spawn(store, TOKEN).await;

    let sem_token = Request::builder()
        .uri("/flare/busy")
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(addr, sem_token).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "sem token a rota não abre"
    );

    let com_token = Request::builder()
        .uri("/flare/busy")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(addr, com_token).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "busy": false }), "forma estável da ponte");
}

/// Sem token configurado a superfície INTEIRA responde 503 — a rota nova não
/// escapa da mesma guarda.
#[tokio::test]
async fn flare_busy_sem_token_configurado_e_503() {
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let addr = spawn(store, "").await;
    let req = Request::builder()
        .uri("/flare/busy")
        .header("x-indexer-test-token", "qualquer")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(addr, req).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
}
