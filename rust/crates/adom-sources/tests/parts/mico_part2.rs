//! Parte 2 dos testes do Mico: SSRF, desfecho tipado e `fetch_streams`.
//!
//! Incluída por `#[path]` a partir de `tests/mico.rs` (que passaria do teto
//! de 400 linhas num arquivo só).

use adom_sources::mico::endpoint_url;
use adom_sources::{
    fetch_streams, MicoClient, MicoConfig, MicoOutcome, MicoSearchOptions, MICO_DEFAULT_URL,
};
use serde_json::json;

use super::{movie_args, stream, test_config, FakeMico, Mode, HASH_LOWER};

#[tokio::test]
async fn ssrf_barra_loopback_sem_allow_private() {
    let (api, base) = FakeMico::start().await;
    let cfg = MicoConfig {
        allow_private_url: false,
        ..test_config(&base)
    };
    let client = MicoClient::new(cfg).expect("client");
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn default_ligado() {
    let cfg = MicoConfig::default();
    assert!(cfg.enabled);
    assert_eq!(cfg.url, MICO_DEFAULT_URL);
}

#[tokio::test]
async fn search_outcome_separa_ok_empty_e_http_400() {
    let (api, base) = FakeMico::start().await;
    let client = MicoClient::new(test_config(&base)).expect("client");
    assert!(matches!(
        client
            .search_outcome(&movie_args("tt1"), MicoSearchOptions::default())
            .await,
        MicoOutcome::Ok(items) if items.is_empty()
    ));

    api.set_streams(json!([stream("Filme 2024", HASH_LOWER)]));
    assert!(matches!(
        client
            .search_outcome(&movie_args("tt1"), MicoSearchOptions::default())
            .await,
        MicoOutcome::Ok(items) if items.len() == 1
    ));

    api.set_mode(Mode::Http400);
    assert_eq!(
        client
            .search_outcome(&movie_args("tt1"), MicoSearchOptions::default())
            .await,
        MicoOutcome::Http(400)
    );
    assert_eq!(client.breaker().failures(), 0, "4xx é neutro");
}

#[tokio::test]
async fn search_outcome_pending_quando_o_deadline_venceu() {
    let (api, base) = FakeMico::start().await;
    let client = MicoClient::new(test_config(&base)).expect("client");
    let options = MicoSearchOptions {
        deadline_at: Some(0),
    };
    assert_eq!(
        client.search_outcome(&movie_args("tt1"), options).await,
        MicoOutcome::Pending
    );
    assert!(api.calls().is_empty(), "pending não faz rede");
    assert_eq!(client.breaker().failures(), 0);
}

#[tokio::test]
async fn fetch_streams_devolve_retry_after_em_segundos_e_data_http() {
    let (api, base) = FakeMico::start().await;
    let url = endpoint_url(&base, &movie_args("tt1"))
        .expect("url")
        .to_string();

    api.set_mode(Mode::Http429RetrySeconds);
    let error = fetch_streams(&url, 1_000).await.expect_err("429");
    assert_eq!(error.status, Some(429));
    assert_eq!(error.retry_after_ms, Some(120_000));

    api.set_mode(Mode::Http429RetryDate);
    let error = fetch_streams(&url, 1_000).await.expect_err("429");
    let retry = error.retry_after_ms.expect("Retry-After data");
    assert!(
        (115_000..=120_000).contains(&retry),
        "data HTTP a ~120s: {retry} ms"
    );
}

#[tokio::test]
async fn fetch_streams_4xx_e_neutro_no_fetch_puro() {
    let (api, base) = FakeMico::start().await;
    api.set_mode(Mode::Http400);
    let url = endpoint_url(&base, &movie_args("tt1"))
        .expect("url")
        .to_string();
    let outcome = fetch_streams(&url, 1_000).await.expect("4xx não lança");
    assert!(outcome.items.is_empty());
    assert!(!outcome.ok);
}
