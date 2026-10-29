//! Testes da guarda DESTRUTIVA do `POST /streams/clear` (e da ausência dela no
//! `POST /streams/invalidate`, que é o caminho quente).
//!
//! Filho de `store_admin_tests` (reusa `spawn_with`, `call`, `post_json` e
//! `entry_with_trace` de lá). O contrato provado aqui:
//!
//! 1. sem `confirm:true` ⇒ 409 `confirmation_required` e store INTACTO;
//! 2. só com o token de diagnóstico ⇒ 403 `streams_token_insufficient` e store
//!    INTACTO;
//! 3. sem NENHUMA credencial destrutiva na config ⇒ 409
//!    `streams_requires_admin_token` e store INTACTO;
//! 4. com as DUAS (credencial + `confirm`) ⇒ apaga e devolve `removed`;
//! 5. `invalidate` (obra/hash) não pede nenhuma das duas.

use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use serde_json::json;

use adom_store::StreamsStore;

use super::{call, entry_with_trace, post_json, spawn_with, TOKEN};

/// Store com UMA entrada viva (`tt5`) — a prova de "nada foi apagado".
fn store_com_uma_entrada() -> Arc<StreamsStore> {
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let key = format!("{}movie:tt5:a", adom_store::streams_prefix());
    store
        .set(&key, &entry_with_trace("aa", 1.0), 600, 0)
        .unwrap();
    store
}

/// Sem `confirm` NADA é apagado: `{}`, `false`, a string `"true"` e `1`
/// recusam com 409 e o store fica intacto.
#[tokio::test]
async fn clear_sem_confirm_recusa_409_e_preserva_o_store() {
    let store = store_com_uma_entrada();
    let addr = spawn_with(store.clone(), TOKEN, Some(TOKEN)).await;

    for body in [
        json!({}),
        json!({ "confirm": false }),
        json!({ "confirm": "true" }),
        json!({ "confirm": 1 }),
    ] {
        let (status, out) = call(addr, post_json("/streams/clear", body.clone(), TOKEN)).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body} => {out}");
        assert_eq!(out["ok"], false);
        assert_eq!(out["error"], "confirmation_required", "{body} => {out}");
    }
    assert_eq!(store.len().unwrap(), 1, "nada foi apagado");
}

/// Corpo AUSENTE também não confirma e não vira 400 do extrator.
#[tokio::test]
async fn clear_sem_corpo_recusa_409_e_preserva_o_store() {
    let store = store_com_uma_entrada();
    let addr = spawn_with(store.clone(), TOKEN, Some(TOKEN)).await;

    let req = Request::builder()
        .method("POST")
        .uri("/streams/clear")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap();
    let (status, out) = call(addr, req).await;
    assert_eq!(status, StatusCode::CONFLICT, "{out}");
    assert_eq!(out["error"], "confirmation_required");
    assert_eq!(store.len().unwrap(), 1, "nada foi apagado");
}

/// Token de DIAGNÓSTICO (o que abre `/metrics.json`) não apaga: 403, sem tocar
/// o store. Aqui as duas credenciais são valores DIFERENTES de propósito — o
/// `auth` aceita a de diagnóstico e a guarda destrutiva recusa.
#[tokio::test]
async fn clear_com_token_de_diagnostico_recusa_403_e_preserva_o_store() {
    let store = store_com_uma_entrada();
    let addr = spawn_with(store.clone(), TOKEN, Some("token-destrutivo")).await;

    let (status, out) = call(
        addr,
        post_json("/streams/clear", json!({ "confirm": true }), TOKEN),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{out}");
    assert_eq!(out["error"], "streams_token_insufficient");
    assert_eq!(out["reason"], "diagnostic_token");
    assert_eq!(store.len().unwrap(), 1, "nada foi apagado");
}

/// Sem NENHUMA credencial destrutiva configurada a rota recusa por
/// configuração (409), mesmo autenticado e confirmado — nunca no-op silencioso.
#[tokio::test]
async fn clear_sem_credencial_destrutiva_recusa_409() {
    let store = store_com_uma_entrada();
    let addr = spawn_with(store.clone(), TOKEN, None).await;

    let (status, out) = call(
        addr,
        post_json("/streams/clear", json!({ "confirm": true }), TOKEN),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{out}");
    assert_eq!(out["error"], "streams_requires_admin_token");
    assert_eq!(out["reason"], "no_destructive_token");
    assert_eq!(store.len().unwrap(), 1, "nada foi apagado");
}

/// O caminho quente: `invalidate` NÃO depende de `confirm` nem da credencial
/// destrutiva (nenhuma configurada aqui) — o `/resolve` e o sidecar do crawl
/// seguem apagando UMA obra.
#[tokio::test]
async fn invalidate_nao_exige_confirm_nem_credencial_destrutiva() {
    let store = store_com_uma_entrada();
    let addr = spawn_with(store.clone(), TOKEN, None).await;

    let (status, out) = call(
        addr,
        post_json("/streams/invalidate", json!({ "imdbId": "tt5" }), TOKEN),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{out}");
    assert_eq!(out["removed"], 1);
    assert_eq!(store.len().unwrap(), 0);
}
