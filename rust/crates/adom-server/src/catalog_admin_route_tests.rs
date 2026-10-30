//! Teste da rota `GET /indexers/catalog` na admin 8711 — mesmo padrão dos
//! `store_admin_tests.rs` (router + token + chamada HTTP real em loopback).
//! O hub é instalado com fetcher FAKE: a rota lê o publicado, sem rede.

use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tokio::net::TcpListener;

use adom_sources::jackett::CatalogSource;
use adom_store::StreamsStore;

use super::tests::{snapshot, FakeFetch};
use super::{install, CatalogHub};
use crate::store_admin::{AdminConfig, DEFAULT_LISTEN};

const TOKEN: &str = "token-de-teste";

#[tokio::test]
async fn catalog_devolve_cards_source_e_mico_virtual() {
    let fetch = Arc::new(FakeFetch::new(vec![snapshot(
        CatalogSource::Live,
        &["comandotorrents", "bludv-cardigann"],
    )]));
    let hub = Arc::new(CatalogHub::new(
        fetch,
        snapshot(CatalogSource::Fallback, &["env-a"]),
        900_000,
        true,
        true,
    ));
    assert!(
        install(hub.clone()),
        "só este teste instala o hub do catálogo"
    );
    let (live, _) = hub.tick().await;
    assert!(live, "o fake devolve live e a rota precisa mostrar isso");

    let cfg = AdminConfig {
        listen: DEFAULT_LISTEN.parse().unwrap(),
        token: TOKEN.to_string(),
        destructive_token: None,
    };
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
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

    let response = crate::proxy::client()
        .request(
            Request::builder()
                .uri(format!("http://{addr}/indexers/catalog"))
                .header("x-indexer-test-token", TOKEN)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap();

    assert_eq!(body["ok"], true, "{body}");
    assert_eq!(body["source"], "live", "{body}");
    let cards = body["cards"].as_array().unwrap();
    assert_eq!(cards.len(), 3, "2 do Jackett fake + o Mico virtual: {body}");
    let primeiro = &cards[0];
    assert_eq!(primeiro["id"], "comandotorrents", "{body}");
    assert_eq!(primeiro["label"], "comandotorrents", "{body}");
    assert_eq!(primeiro["language"], "pt-BR", "{body}");
    assert_eq!(primeiro["isBr"], true, "{body}");
    assert!(
        primeiro.get("virtual").is_none(),
        "card da coleta não carrega `virtual`: {body}"
    );
    let mico = cards.last().unwrap();
    assert_eq!(mico["id"], "mico", "{body}");
    assert_eq!(mico["virtual"], true, "{body}");
    assert_eq!(mico["isBr"], true, "{body}");
}
