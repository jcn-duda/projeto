//! Cliente Mico contra servidor falso (axum) — URL por IMDb, parse JSON,
//! dedupe, breaker local e fail-open.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_sources::mico::endpoint_url;
use adom_sources::{
    fetch_streams, MicoClient, MicoConfig, MicoMediaType, MicoOutcome, MicoSearchArgs,
    MicoSearchOptions, MICO_DEFAULT_URL, MICO_ID,
};
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};

const EYES: char = '\u{1F465}';
const DISK: char = '\u{1F4BE}';
const HASH_LOWER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_UPPER: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[derive(Clone, Default)]
struct FakeMico {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    calls: Mutex<Vec<String>>,
    mode: Mutex<Mode>,
    payload: Mutex<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Mode {
    #[default]
    Ok,
    Http400,
    Http429RetrySeconds,
    Http429RetryDate,
    Http503,
    Hang,
}

impl Mode {
    fn retry_after(self) -> Option<String> {
        match self {
            Self::Http429RetrySeconds => Some("120".to_string()),
            Self::Http429RetryDate => {
                let when = std::time::SystemTime::now() + Duration::from_secs(120);
                Some(httpdate::fmt_http_date(when))
            }
            _ => None,
        }
    }

    fn status(self) -> StatusCode {
        match self {
            Self::Http400 => StatusCode::BAD_REQUEST,
            Self::Http429RetrySeconds | Self::Http429RetryDate => StatusCode::TOO_MANY_REQUESTS,
            Self::Http503 => StatusCode::SERVICE_UNAVAILABLE,
            Self::Ok | Self::Hang => StatusCode::OK,
        }
    }
}

impl FakeMico {
    async fn start() -> (Self, String) {
        let api = Self {
            inner: Arc::new(Inner {
                payload: Mutex::new(json!({ "streams": [] })),
                ..Inner::default()
            }),
        };
        let app = Router::new()
            .route("/stream/movie/{id}", get(movie))
            .route("/stream/series/{id}", get(series))
            .with_state(api.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (api, format!("http://{addr}"))
    }

    fn set_mode(&self, mode: Mode) {
        *self.inner.mode.lock().expect("mode") = mode;
    }

    fn set_streams(&self, streams: Value) {
        *self.inner.payload.lock().expect("payload") = json!({ "streams": streams });
    }

    fn calls(&self) -> Vec<String> {
        self.inner.calls.lock().expect("calls").clone()
    }
}

async fn movie(State(api): State<FakeMico>, Path(id): Path<String>) -> Response {
    respond(api, format!("/stream/movie/{id}")).await
}

async fn series(State(api): State<FakeMico>, Path(id): Path<String>) -> Response {
    respond(api, format!("/stream/series/{id}")).await
}

async fn respond(api: FakeMico, path: String) -> Response {
    api.inner.calls.lock().expect("calls").push(path);
    let mode = *api.inner.mode.lock().expect("mode");
    match mode {
        Mode::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            StatusCode::OK.into_response()
        }
        Mode::Ok => {
            let body = api.inner.payload.lock().expect("payload").clone();
            (StatusCode::OK, axum::Json(body)).into_response()
        }
        other => {
            let status = other.status();
            match other.retry_after() {
                Some(retry) => (status, [(header::RETRY_AFTER, retry)]).into_response(),
                None => status.into_response(),
            }
        }
    }
}

fn test_config(base: &str) -> MicoConfig {
    MicoConfig {
        enabled: true,
        url: base.to_string(),
        timeout_ms: 1_000,
        breaker_failures: 2,
        breaker_cooldown_ms: 60_000,
        allow_private_url: true,
    }
}

fn movie_args(imdb: &str) -> MicoSearchArgs {
    MicoSearchArgs {
        media_type: MicoMediaType::Movie,
        imdb_id: imdb.into(),
        season: None,
        episode: None,
        year: None,
    }
}

fn series_args(imdb: &str, season: i32, episode: i32) -> MicoSearchArgs {
    MicoSearchArgs {
        media_type: MicoMediaType::Series,
        imdb_id: imdb.into(),
        season: Some(season),
        episode: Some(episode),
        year: None,
    }
}

fn stream(title: &str, info_hash: &str) -> Value {
    json!({ "title": title, "infoHash": info_hash })
}

#[tokio::test]
async fn enabled_false_sem_rede() {
    let (api, base) = FakeMico::start().await;
    let cfg = MicoConfig {
        enabled: false,
        ..test_config(&base)
    };
    let client = MicoClient::new(cfg).expect("client");
    let out = client.search(&movie_args("tt7286456")).await;
    assert!(out.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn filme_e_serie_montam_url() {
    let (api, base) = FakeMico::start().await;
    let client = MicoClient::new(test_config(&base)).expect("client");

    let _ = client.search(&movie_args("tt7286456")).await;
    assert_eq!(
        api.calls(),
        vec!["/stream/movie/tt7286456.json".to_string()]
    );

    let url = endpoint_url(&base, &movie_args("tt7286456")).expect("url");
    assert!(url.as_str().ends_with("/stream/movie/tt7286456.json"));

    let _ = client.search(&series_args("tt7286456", 1, 2)).await;
    assert!(api
        .calls()
        .iter()
        .any(|c| c == "/stream/series/tt7286456:1:2.json"));
}

#[tokio::test]
async fn args_incompletos_sem_rede() {
    let (api, base) = FakeMico::start().await;
    let client = MicoClient::new(test_config(&base)).expect("client");

    assert!(client.search(&movie_args("")).await.is_empty());
    assert!(client.search(&movie_args("tt")).await.is_empty());

    let no_ep = MicoSearchArgs {
        media_type: MicoMediaType::Series,
        imdb_id: "tt7286456".into(),
        season: Some(1),
        episode: None,
        year: None,
    };
    assert!(client.search(&no_ep).await.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn parse_titulo_seeders_size_e_magnet() {
    let (api, base) = FakeMico::start().await;
    let title = format!("Coringa 2019 Dublado {EYES} 42 {DISK} 2.1 GB (brazilian, eng)");
    api.set_streams(json!([
        {
            "title": title,
            "infoHash": HASH_UPPER,
            "sources": ["tracker:udp://tracker.example:80"]
        }
    ]));

    let client = MicoClient::new(test_config(&base)).expect("client");
    let out = client.search(&movie_args("tt7286456")).await;
    assert_eq!(out.len(), 1);
    let item = &out[0];
    assert_eq!(item.title, "Coringa 2019 Dublado");
    assert_eq!(item.info_hash, HASH_LOWER);
    assert_eq!(item.seeders, 42.0);
    assert_eq!(item.size, Some((2.1 * 1024.0_f64.powi(3)).round()));
    assert_eq!(item.indexer, MICO_ID);
    assert!(item.is_br);
    assert!(item.magnet.contains("btih:aaaaaaaa"));
    assert!(item.magnet.contains("tr=udp%3A%2F%2Ftracker.example%3A80"));
    assert!(!item.magnet.contains("dn="));
}

#[tokio::test]
async fn hash_invalido_e_dedupe() {
    let (api, base) = FakeMico::start().await;
    api.set_streams(json!([
        stream("ruim", "nao-e-hash"),
        stream("curto", "abc"),
        stream("primeiro", HASH_LOWER),
        stream("segundo-mesmo-hash", HASH_LOWER),
        stream("outro", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ]));
    let client = MicoClient::new(test_config(&base)).expect("client");
    let out = client.search(&movie_args("tt7286456")).await;
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].title, "primeiro");
    assert_eq!(out[1].info_hash, "b".repeat(40));
}

#[tokio::test]
async fn http_400_nao_abre_breaker() {
    let (api, base) = FakeMico::start().await;
    api.set_mode(Mode::Http400);
    let cfg = MicoConfig {
        breaker_failures: 1,
        ..test_config(&base)
    };
    let client = MicoClient::new(cfg).expect("client");
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(client.breaker().failures(), 0);
    assert!(client.search(&movie_args("tt2")).await.is_empty());
    assert_eq!(api.calls().len(), 2);
}

#[tokio::test]
async fn breaker_abre_em_503_e_bloqueia() {
    let (api, base) = FakeMico::start().await;
    api.set_mode(Mode::Http503);
    let cfg = MicoConfig {
        breaker_failures: 2,
        breaker_cooldown_ms: 60_000,
        ..test_config(&base)
    };
    let client = MicoClient::new(cfg).expect("client");

    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 2);

    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 2);

    client.reset_breaker();
    api.set_mode(Mode::Ok);
    api.set_streams(json!([stream("ok", HASH_LOWER)]));
    let out = client.search(&movie_args("tt1")).await;
    assert_eq!(out.len(), 1);
    assert_eq!(api.calls().len(), 3);
}

#[tokio::test]
async fn breaker_meia_abre_apos_cooldown() {
    let (api, base) = FakeMico::start().await;
    api.set_mode(Mode::Http503);
    let cfg = MicoConfig {
        breaker_failures: 1,
        breaker_cooldown_ms: 40,
        ..test_config(&base)
    };
    let client = MicoClient::new(cfg).expect("client");

    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 1);
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 1, "ainda no cooldown");

    tokio::time::sleep(Duration::from_millis(80)).await;
    api.set_mode(Mode::Ok);
    api.set_streams(json!([stream("ok", HASH_LOWER)]));
    let out = client.search(&movie_args("tt1")).await;
    assert_eq!(out.len(), 1);
    assert_eq!(api.calls().len(), 2);
}

#[tokio::test]
async fn timeout_conta_falha_no_breaker() {
    let (api, base) = FakeMico::start().await;
    api.set_mode(Mode::Hang);
    let cfg = MicoConfig {
        timeout_ms: 60,
        breaker_failures: 1,
        breaker_cooldown_ms: 60_000,
        ..test_config(&base)
    };
    let client = MicoClient::new(cfg).expect("client");
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(client.breaker().failures(), 1);
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 1, "aberto após timeout");
}

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
            .search_outcome(&movie_args("tt1"), MicoSearchOptions::LIVE)
            .await,
        MicoOutcome::Ok(items) if items.is_empty()
    ));

    api.set_streams(json!([stream("Filme 2024", HASH_LOWER)]));
    assert!(matches!(
        client
            .search_outcome(&movie_args("tt1"), MicoSearchOptions::LIVE)
            .await,
        MicoOutcome::Ok(items) if items.len() == 1
    ));

    api.set_mode(Mode::Http400);
    assert_eq!(
        client
            .search_outcome(&movie_args("tt1"), MicoSearchOptions::LIVE)
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
        read_only: false,
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
async fn search_outcome_shadow_ignora_o_breaker_e_nao_o_alimenta() {
    let (api, base) = FakeMico::start().await;
    api.set_mode(Mode::Http503);
    let client = MicoClient::new(MicoConfig {
        breaker_failures: 1,
        ..test_config(&base)
    })
    .expect("client");

    // Caminho vivo abre o circuito.
    assert_eq!(
        client
            .search_outcome(&movie_args("tt1"), MicoSearchOptions::LIVE)
            .await,
        MicoOutcome::Http(503)
    );
    assert_eq!(client.breaker().failures(), 1);
    assert_eq!(
        client
            .search_outcome(&movie_args("tt1"), MicoSearchOptions::LIVE)
            .await,
        MicoOutcome::BreakerOpen
    );
    assert_eq!(api.calls().len(), 1);

    // Sombra consulta mesmo aberto e não mexe no contador.
    api.set_mode(Mode::Ok);
    assert!(matches!(
        client
            .search_outcome(&movie_args("tt1"), MicoSearchOptions::SHADOW)
            .await,
        MicoOutcome::Ok(_)
    ));
    assert_eq!(api.calls().len(), 2);
    assert_eq!(client.breaker().failures(), 1);
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
