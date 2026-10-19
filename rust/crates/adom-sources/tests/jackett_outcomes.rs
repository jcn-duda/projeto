//! Contrato de desfecho POR INDEXER do Jackett (F2.1): 200 vazio, 500,
//! timeout e duas consultas com uma falhando. Servidor falso local — nenhum
//! Jackett real e nenhuma rede externa.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use adom_sources::jackett::{
    IndexerStatus, JackettClient, JackettConfig, JackettMediaType, SearchOptions, ALL_QUERY_INDEXER,
};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;

#[derive(Clone, Default)]
struct Hits(Arc<AtomicUsize>);

async fn start_fake_with_hits() -> (String, Hits) {
    let hits = Hits::default();
    let app = Router::new()
        .route("/api/v2.0/indexers/{indexer}/results", get(results))
        .with_state(hits.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), hits)
}

async fn start_fake() -> String {
    start_fake_with_hits().await.0
}

async fn results(State(hits): State<Hits>, Path(indexer): Path<String>) -> Response {
    hits.0.fetch_add(1, Ordering::SeqCst);
    match indexer.as_str() {
        "empty" | "all" => (
            StatusCode::OK,
            axum::Json(json!({
                "Results": [],
                "Indexers": [{ "Status": 2, "Error": null }]
            })),
        )
            .into_response(),
        // HTTP 200 com o indexer morto DENTRO do envelope.
        "envelope" => (
            StatusCode::OK,
            axum::Json(json!({
                "Results": [],
                "Indexers": [{ "Status": 1, "Error": "BadGateway\nstack" }]
            })),
        )
            .into_response(),
        "offline" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        "slow" => {
            tokio::time::sleep(Duration::from_millis(500)).await;
            ok_payload(&indexer).into_response()
        }
        _ => ok_payload(&indexer).into_response(),
    }
}

fn ok_payload(indexer: &str) -> axum::Json<serde_json::Value> {
    axum::Json(json!({
        "Results": [{
            "Title": "Release",
            "MagnetUri": "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "InfoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "Seeders": 5,
            "Size": 1234,
            "Tracker": indexer,
            "TrackerId": indexer,
            "Category": [2000]
        }],
        "Indexers": [{ "Status": 2, "Error": null }]
    }))
}

/// Ramo agregado `/all` que nunca responde dentro do prazo.
async fn start_slow_all() -> String {
    let app = Router::new().route(
        "/api/v2.0/indexers/all/results",
        get(|| async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            ok_payload("all")
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

fn test_config(base: &str) -> JackettConfig {
    JackettConfig {
        url: base.to_string(),
        api_key: "chave-teste".into(),
        indexer_timeout_ms: 80,
        br_indexer_timeout_ms: 80,
        ..JackettConfig::default()
    }
}

#[tokio::test]
async fn http_200_vazio_vira_empty() {
    let base = start_fake().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let outcomes = client
        .search_outcomes(
            "x",
            JackettMediaType::Movie,
            &["empty".into()],
            &SearchOptions::default(),
        )
        .await;
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].status, IndexerStatus::Empty);
    assert!(outcomes[0].source_ok, "200 válido é fonte saudável");
    assert!(outcomes[0].source_error.is_none());
    assert!(outcomes[0].items.is_empty());
}

#[tokio::test]
async fn http_500_vira_failed_com_motivo() {
    let base = start_fake().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let outcomes = client
        .search_outcomes(
            "x",
            JackettMediaType::Movie,
            &["offline".into()],
            &SearchOptions::default(),
        )
        .await;
    assert_eq!(outcomes[0].status, IndexerStatus::Failed);
    assert!(!outcomes[0].source_ok);
    assert!(outcomes[0]
        .source_error
        .as_deref()
        .is_some_and(|err| err.contains("HTTP 500")));
}

#[tokio::test]
async fn timeout_vira_failed_nao_pending() {
    let base = start_fake().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let outcomes = client
        .search_outcomes(
            "x",
            JackettMediaType::Movie,
            &["slow".into()],
            &SearchOptions::default(),
        )
        .await;
    assert_eq!(outcomes[0].status, IndexerStatus::Failed);
    assert!(!outcomes[0].source_ok);
    assert_eq!(outcomes[0].source_error.as_deref(), Some("timeout"));
}

#[tokio::test]
async fn timeout_do_all_tambem_vira_failed() {
    let base = start_slow_all().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let outcomes = client
        .search_outcomes("x", JackettMediaType::Movie, &[], &SearchOptions::default())
        .await;
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].indexer, ALL_QUERY_INDEXER);
    assert_eq!(outcomes[0].status, IndexerStatus::Failed);
    assert_eq!(outcomes[0].source_error.as_deref(), Some("timeout"));
}

#[tokio::test]
async fn envelope_200_com_indexer_morto_vira_failed() {
    let base = start_fake().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let outcomes = client
        .search_outcomes(
            "x",
            JackettMediaType::Movie,
            &["envelope".into()],
            &SearchOptions::default(),
        )
        .await;
    assert_eq!(outcomes[0].status, IndexerStatus::Failed);
    assert!(!outcomes[0].source_ok);
    assert_eq!(outcomes[0].source_error.as_deref(), Some("BadGateway"));
}

#[tokio::test]
async fn breaker_aberto_vira_failed_sem_nova_consulta() {
    let (base, hits) = start_fake_with_hits().await;
    let client = JackettClient::new(JackettConfig {
        breaker_failures: 1,
        breaker_cooldown_ms: 60_000,
        ..test_config(&base)
    })
    .expect("client");
    // Primeira consulta falha e arma o circuito.
    let first = client
        .search_outcomes(
            "x",
            JackettMediaType::Movie,
            &["offline".into()],
            &SearchOptions::default(),
        )
        .await;
    assert_eq!(first[0].status, IndexerStatus::Failed);
    let before = hits.0.load(Ordering::SeqCst);
    // Segunda nem sai para a rede: o breaker é um desfecho declarado.
    let second = client
        .search_outcomes(
            "x",
            JackettMediaType::Movie,
            &["offline".into()],
            &SearchOptions::default(),
        )
        .await;
    assert_eq!(second[0].status, IndexerStatus::Failed);
    assert_eq!(second[0].source_error.as_deref(), Some("breaker"));
    assert_eq!(
        hits.0.load(Ordering::SeqCst),
        before,
        "circuito aberto não dispara HTTP"
    );
}

#[tokio::test]
async fn ordem_dos_indexers_e_preservada_mesmo_com_lento_primeiro() {
    let base = start_fake().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let outcomes = client
        .search_outcomes(
            "x",
            JackettMediaType::Movie,
            &["slow".into(), "yts".into()],
            &SearchOptions::default(),
        )
        .await;
    assert_eq!(
        outcomes
            .iter()
            .map(|o| o.indexer.as_str())
            .collect::<Vec<_>>(),
        vec!["slow", "yts"]
    );
}

#[tokio::test]
async fn record_status_false_viaja_no_outcome() {
    let base = start_fake().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let options = SearchOptions {
        record_status: Some(false),
        ..SearchOptions::default()
    };
    let outcomes = client
        .search_outcomes("x", JackettMediaType::Movie, &["offline".into()], &options)
        .await;
    assert!(!outcomes[0].record_status);
}

#[tokio::test]
async fn dois_indexers_um_falha_preserva_os_dois() {
    let base = start_fake().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let outcomes = client
        .search_outcomes(
            "x",
            JackettMediaType::Movie,
            &["yts".into(), "offline".into()],
            &SearchOptions::default(),
        )
        .await;
    assert_eq!(outcomes.len(), 2);
    let yts = outcomes
        .iter()
        .find(|o| o.indexer == "yts")
        .expect("yts presente");
    let offline = outcomes
        .iter()
        .find(|o| o.indexer == "offline")
        .expect("offline presente");
    assert_eq!(yts.status, IndexerStatus::Ok);
    assert_eq!(offline.status, IndexerStatus::Failed);
    assert_eq!(
        outcomes.iter().map(|o| o.items.len()).sum::<usize>(),
        1,
        "o indexer bom continua entregando item"
    );
}

#[tokio::test]
async fn agregado_all_vazio_vira_empty_sem_nome_de_indexer() {
    let base = start_fake().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let outcomes = client
        .search_outcomes("x", JackettMediaType::Movie, &[], &SearchOptions::default())
        .await;
    assert_eq!(outcomes.len(), 1);
    assert_eq!(outcomes[0].indexer, ALL_QUERY_INDEXER);
    assert_eq!(outcomes[0].status, IndexerStatus::Empty);
    assert!(outcomes[0].source_ok);
}
