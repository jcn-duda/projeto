//! Cliente Torrentio contra servidor falso (axum) — URL pública, parse,
//! fileIdx, dedupe e breaker local.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_sources::torrentio::endpoint_url;
use adom_sources::{TorrentioClient, TorrentioConfig, TorrentioMediaType, TorrentioSearchArgs};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};

const META_USER: char = '\u{1F464}';
const META_DISK: char = '\u{1F4BE}';
const META_GEAR: char = '\u{2699}';
const HASH_LOWER: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_UPPER: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

#[derive(Clone, Default)]
struct FakeTorrentio {
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
    Http429,
    Http503,
    InvalidJson,
    Hang,
}

impl FakeTorrentio {
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

async fn movie(State(api): State<FakeTorrentio>, Path(id): Path<String>) -> Response {
    respond(api, format!("/stream/movie/{id}")).await
}

async fn series(State(api): State<FakeTorrentio>, Path(id): Path<String>) -> Response {
    respond(api, format!("/stream/series/{id}")).await
}

async fn respond(api: FakeTorrentio, path: String) -> Response {
    api.inner.calls.lock().expect("calls").push(path);
    let mode = *api.inner.mode.lock().expect("mode");
    match mode {
        Mode::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            StatusCode::OK.into_response()
        }
        Mode::Http400 => StatusCode::BAD_REQUEST.into_response(),
        Mode::Http429 => StatusCode::TOO_MANY_REQUESTS.into_response(),
        Mode::Http503 => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        Mode::InvalidJson => (StatusCode::OK, "isto não é json").into_response(),
        Mode::Ok => {
            let body = api.inner.payload.lock().expect("payload").clone();
            (StatusCode::OK, axum::Json(body)).into_response()
        }
    }
}

fn test_config(base: &str) -> TorrentioConfig {
    TorrentioConfig {
        enabled: true,
        default_on: false,
        url: base.to_string(),
        timeout_ms: 1_000,
        breaker_failures: 2,
        breaker_cooldown_ms: 60_000,
        allow_private_url: true,
    }
}

fn movie_args(imdb: &str) -> TorrentioSearchArgs {
    TorrentioSearchArgs {
        media_type: TorrentioMediaType::Movie,
        imdb_id: imdb.into(),
        season: None,
        episode: None,
    }
}

fn series_args(imdb: &str, season: i32, episode: i32) -> TorrentioSearchArgs {
    TorrentioSearchArgs {
        media_type: TorrentioMediaType::Series,
        imdb_id: imdb.into(),
        season: Some(season),
        episode: Some(episode),
    }
}

fn stream(title: &str, info_hash: &str, file_idx: Option<f64>) -> Value {
    let mut v = json!({ "title": title, "infoHash": info_hash });
    if let Some(idx) = file_idx {
        v["fileIdx"] = json!(idx);
    }
    v
}

#[tokio::test]
async fn enabled_false_sem_rede() {
    let (api, base) = FakeTorrentio::start().await;
    let cfg = TorrentioConfig {
        enabled: false,
        ..test_config(&base)
    };
    let client = TorrentioClient::new(cfg).expect("client");
    let out = client.search(&movie_args("tt6791350")).await;
    assert!(out.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn filme_e_serie_montam_url_sem_credencial() {
    let (api, base) = FakeTorrentio::start().await;
    let client = TorrentioClient::new(test_config(&base)).expect("client");

    let _ = client.search(&movie_args("tt6791350")).await;
    assert_eq!(
        api.calls(),
        vec!["/stream/movie/tt6791350.json".to_string()]
    );

    let url = endpoint_url(&base, &movie_args("tt6791350")).expect("url");
    let s = url.as_str();
    assert!(!s.contains("realdebrid="));
    assert!(!s.contains("apiKey"));

    let _ = client.search(&series_args("tt6791350", 3, 1)).await;
    assert!(api
        .calls()
        .iter()
        .any(|c| c == "/stream/series/tt6791350:3:1.json"));
}

#[tokio::test]
async fn args_incompletos_sem_rede() {
    let (api, base) = FakeTorrentio::start().await;
    let client = TorrentioClient::new(test_config(&base)).expect("client");

    let empty_movie = TorrentioSearchArgs {
        imdb_id: String::new(),
        ..movie_args("")
    };
    assert!(client.search(&empty_movie).await.is_empty());

    let no_ep = TorrentioSearchArgs {
        media_type: TorrentioMediaType::Series,
        imdb_id: "tt6791350".into(),
        season: Some(3),
        episode: None,
    };
    assert!(client.search(&no_ep).await.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn parse_preserva_file_idx_e_metadados() {
    let (api, base) = FakeTorrentio::start().await;
    let meta = format!("{META_USER} 1,234 {META_DISK} 2.4 GB {META_GEAR}\u{FE0F} Torrentio");
    let title = format!(
        "{meta}\nGuardiões da Galáxia Vol. 3 (2023) [4K] [Dual] [RD+]\narquivo1.mkv\narquivo2.mkv"
    );
    api.set_streams(json!([stream(&title, HASH_UPPER, Some(2.0))]));

    let client = TorrentioClient::new(test_config(&base)).expect("client");
    let out = client.search(&movie_args("tt6791350")).await;
    assert_eq!(out.len(), 1);
    let item = &out[0];
    assert_eq!(
        item.title,
        "Guardiões da Galáxia Vol. 3 (2023) [4K] [Dual] [RD+]\narquivo1.mkv\narquivo2.mkv"
    );
    assert_eq!(item.seeders, 1234.0);
    assert_eq!(item.size, Some((2.4 * 1024.0_f64.powi(3)).round()));
    assert_eq!(item.tracker.as_deref(), Some("Torrentio"));
    assert_eq!(item.indexer, "torrentio");
    assert_eq!(item.file_idx, Some(2));
    assert_eq!(item.info_hash, HASH_LOWER);
}

#[tokio::test]
async fn hash_invalido_e_dedupe() {
    let (api, base) = FakeTorrentio::start().await;
    api.set_streams(json!([
        stream("ruim", "nao-e-hash", Some(0.0)),
        stream("curto", "abc", None),
        stream("primeiro", HASH_LOWER, None),
        stream("segundo-mesmo-hash", HASH_LOWER, None),
        stream("outro", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", None),
    ]));
    let client = TorrentioClient::new(test_config(&base)).expect("client");
    let out = client.search(&movie_args("tt6791350")).await;
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].title, "primeiro");
    assert_eq!(out[1].info_hash, "b".repeat(40));
}

#[tokio::test]
async fn http_400_nao_abre_breaker() {
    let (api, base) = FakeTorrentio::start().await;
    api.set_mode(Mode::Http400);
    let cfg = TorrentioConfig {
        breaker_failures: 1,
        ..test_config(&base)
    };
    let client = TorrentioClient::new(cfg).expect("client");
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(client.breaker().failures(), 0);
    // Segunda chamada ainda vai à rede (breaker fechado).
    assert!(client.search(&movie_args("tt2")).await.is_empty());
    assert_eq!(api.calls().len(), 2);
}

#[tokio::test]
async fn breaker_abre_em_503_e_bloqueia() {
    let (api, base) = FakeTorrentio::start().await;
    api.set_mode(Mode::Http503);
    let cfg = TorrentioConfig {
        breaker_failures: 2,
        breaker_cooldown_ms: 60_000,
        ..test_config(&base)
    };
    let client = TorrentioClient::new(cfg).expect("client");

    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 2);

    // Aberto: sem rede.
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 2);

    client.reset_breaker();
    api.set_mode(Mode::Ok);
    api.set_streams(json!([stream("ok", HASH_LOWER, None)]));
    let out = client.search(&movie_args("tt1")).await;
    assert_eq!(out.len(), 1);
    assert_eq!(api.calls().len(), 3);
}

#[tokio::test]
async fn breaker_meia_abre_apos_cooldown() {
    let (api, base) = FakeTorrentio::start().await;
    api.set_mode(Mode::Http503);
    let cfg = TorrentioConfig {
        breaker_failures: 1,
        breaker_cooldown_ms: 40,
        ..test_config(&base)
    };
    let client = TorrentioClient::new(cfg).expect("client");

    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 1);
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 1, "ainda no cooldown");

    tokio::time::sleep(Duration::from_millis(80)).await;
    api.set_mode(Mode::Ok);
    api.set_streams(json!([stream("ok", HASH_LOWER, None)]));
    let out = client.search(&movie_args("tt1")).await;
    assert_eq!(out.len(), 1);
    assert_eq!(api.calls().len(), 2);

    let again = client.search(&movie_args("tt1")).await;
    assert_eq!(again.len(), 1);
    assert_eq!(api.calls().len(), 3);
}

#[tokio::test]
async fn timeout_conta_falha_no_breaker() {
    let (api, base) = FakeTorrentio::start().await;
    api.set_mode(Mode::Hang);
    let cfg = TorrentioConfig {
        timeout_ms: 60,
        breaker_failures: 1,
        breaker_cooldown_ms: 60_000,
        ..test_config(&base)
    };
    let client = TorrentioClient::new(cfg).expect("client");
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(client.breaker().failures(), 1);
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert_eq!(api.calls().len(), 1, "aberto após timeout");
}

#[tokio::test]
async fn ssrf_barra_loopback_sem_allow_private() {
    let (api, base) = FakeTorrentio::start().await;
    let cfg = TorrentioConfig {
        allow_private_url: false,
        ..test_config(&base)
    };
    let client = TorrentioClient::new(cfg).expect("client");
    assert!(client.search(&movie_args("tt1")).await.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn default_on_false_no_config() {
    let cfg = TorrentioConfig::default();
    assert!(!cfg.default_on);
    assert!(cfg.enabled);
}

// ── Desfecho tipado (`search_outcome`) e breaker ───────────────────────

use adom_sources::TorrentioOutcome;

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
