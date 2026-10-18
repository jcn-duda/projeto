//! Cliente Mico contra servidor falso (axum) — URL por IMDb, parse JSON,
//! dedupe, breaker local e fail-open.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_sources::mico::endpoint_url;
use adom_sources::{
    MicoClient, MicoConfig, MicoMediaType, MicoSearchArgs, MICO_DEFAULT_URL, MICO_ID,
};
use axum::extract::{Path, State};
use axum::http::StatusCode;
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
    Http503,
    Hang,
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
        Mode::Http400 => StatusCode::BAD_REQUEST.into_response(),
        Mode::Http503 => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        Mode::Ok => {
            let body = api.inner.payload.lock().expect("payload").clone();
            (StatusCode::OK, axum::Json(body)).into_response()
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
