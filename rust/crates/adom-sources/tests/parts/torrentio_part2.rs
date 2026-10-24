//! Parte 2 dos testes do Torrentio: desfecho tipado e breaker.
//!
//! Incluída por `#[path]` a partir de `tests/torrentio.rs` (que passaria do
//! teto de 400 linhas num arquivo só).

use adom_sources::{TorrentioClient, TorrentioConfig, TorrentioOutcome, TorrentioSearchArgs};
use serde_json::json;

use super::{movie_args, test_config, FakeTorrentio, Mode};

// ── Desfecho tipado (`search_outcome`) e breaker ───────────────────────

#[tokio::test]
async fn outcome_disabled_sem_rede() {
    let (api, base) = FakeTorrentio::start().await;
    let cfg = TorrentioConfig {
        enabled: false,
        ..test_config(&base)
    };
    let client = TorrentioClient::new(cfg).expect("client");
    let out = client.search_outcome(&movie_args("tt1")).await;
    assert_eq!(out, TorrentioOutcome::Disabled);
    assert!(!out.is_host_failure());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn outcome_url_barrada_nao_e_falha_do_host() {
    let client = TorrentioClient::new(TorrentioConfig {
        url: "file:///etc/passwd".into(),
        ..test_config("http://127.0.0.1:9")
    })
    .expect("client");
    let out = client.search_outcome(&movie_args("tt1")).await;
    assert_eq!(out, TorrentioOutcome::BlockedUrl);
    assert!(!out.is_host_failure());
}

#[tokio::test]
async fn outcome_no_endpoint_sem_rede() {
    let (api, base) = FakeTorrentio::start().await;
    let client = TorrentioClient::new(test_config(&base)).expect("client");
    let sem_imdb = TorrentioSearchArgs {
        imdb_id: String::new(),
        ..movie_args("")
    };
    let out = client.search_outcome(&sem_imdb).await;
    assert_eq!(out, TorrentioOutcome::NoEndpoint);
    assert!(!out.is_host_failure());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn outcome_json_sem_streams_e_ok_vazio() {
    let (api, base) = FakeTorrentio::start().await;
    // `{"streams": {...}}` não é array: o TS cai em `[]` e conta SUCESSO.
    api.set_streams(json!({ "nao": "array" }));
    let client = TorrentioClient::new(test_config(&base)).expect("client");
    let out = client.search_outcome(&movie_args("tt1")).await;
    assert_eq!(out, TorrentioOutcome::Ok(Vec::new()));
    assert!(!out.is_host_failure());
    assert_eq!(client.breaker().failures(), 0);
}

#[tokio::test]
async fn outcome_http_400_nao_e_falha_do_host_e_429_5xx_sao() {
    let (api, base) = FakeTorrentio::start().await;
    let client = TorrentioClient::new(test_config(&base)).expect("client");
    api.set_mode(Mode::Http400);
    let four = client.search_outcome(&movie_args("tt1")).await;
    assert_eq!(four, TorrentioOutcome::Http(400));
    assert!(!four.is_host_failure(), "4xx da obra não abre o breaker");
    assert_eq!(client.breaker().failures(), 0);

    api.set_mode(Mode::Http429);
    let rate = client.search_outcome(&movie_args("tt1")).await;
    assert_eq!(rate, TorrentioOutcome::Http(429));
    assert!(rate.is_host_failure());
    assert_eq!(client.breaker().failures(), 1);

    client.reset_breaker();
    api.set_mode(Mode::Http503);
    let down = client.search_outcome(&movie_args("tt1")).await;
    assert_eq!(down, TorrentioOutcome::Http(503));
    assert!(down.is_host_failure());
    assert_eq!(client.breaker().failures(), 1);
}

#[tokio::test]
async fn outcome_json_invalido_rede_e_timeout_sao_falha() {
    let (api, base) = FakeTorrentio::start().await;
    let client = TorrentioClient::new(test_config(&base)).expect("client");

    api.set_mode(Mode::InvalidJson);
    let invalido = client.search_outcome(&movie_args("tt1")).await;
    assert_eq!(invalido, TorrentioOutcome::InvalidJson);
    assert!(invalido.is_host_failure());

    // Falha de transporte SEM timeout: TLS contra um servidor HTTP puro.
    // (Porta fechada em loopback/NTWS vira `is_timeout` do reqwest — depende do
    // sistema, então não serve para provar a variante `Network`.)
    let (_plain, plain_base) = FakeTorrentio::start().await;
    let tls = plain_base.replace("http://", "https://");
    let sem_host = TorrentioClient::new(TorrentioConfig {
        timeout_ms: 1_000,
        ..test_config(&tls)
    })
    .expect("client");
    let rede = sem_host.search_outcome(&movie_args("tt1")).await;
    assert!(
        matches!(rede, TorrentioOutcome::Network(_)),
        "veio {rede:?}"
    );
    assert!(rede.is_host_failure());

    api.set_mode(Mode::Hang);
    let lento = TorrentioClient::new(TorrentioConfig {
        timeout_ms: 60,
        ..test_config(&base)
    })
    .expect("client");
    let timeout = lento.search_outcome(&movie_args("tt1")).await;
    assert_eq!(timeout, TorrentioOutcome::Timeout);
    assert!(timeout.is_host_failure());
}

/// Breaker aberto no caminho vivo: consulta pulada, sem rede e sem nova falha.
#[tokio::test]
async fn outcome_breaker_aberto_nao_vai_a_rede() {
    let (api, base) = FakeTorrentio::start().await;
    api.set_mode(Mode::Http503);
    let client = TorrentioClient::new(TorrentioConfig {
        breaker_failures: 1,
        ..test_config(&base)
    })
    .expect("client");
    let first = client.search_outcome(&movie_args("tt1")).await;
    assert_eq!(first, TorrentioOutcome::Http(503));
    assert_eq!(api.calls().len(), 1);
    let blocked = client.search_outcome(&movie_args("tt1")).await;
    assert_eq!(blocked, TorrentioOutcome::BreakerOpen);
    assert_eq!(api.calls().len(), 1, "aberto não faz rede");
    assert_eq!(
        client.breaker().failures(),
        1,
        "não incrementa sem consulta"
    );
}
