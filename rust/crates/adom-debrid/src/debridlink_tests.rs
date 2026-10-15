use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::PlayHint;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;

use super::DebridLink;

pub(super) const API_KEY: &str = "test-debridlink-key-123";
pub(super) const H1: &str = "1111111111111111111111111111111111111111";
pub(super) const SHOW: &str = "ShowSeason";

static ENV_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

pub(super) struct EnvReset {
    prev: Option<String>,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl EnvReset {
    async fn set(base: &str) -> Self {
        let guard = ENV_LOCK.lock().await;
        let prev = std::env::var("DEBRIDLINK_API_BASE").ok();
        // SAFETY: o mutex serializa estes testes. A variável só aponta o
        // adaptador para o servidor local e o Drop restaura o valor anterior.
        unsafe { std::env::set_var("DEBRIDLINK_API_BASE", base) };
        Self {
            prev,
            _guard: guard,
        }
    }
}

impl Drop for EnvReset {
    fn drop(&mut self) {
        unsafe {
            match &self.prev {
                Some(value) => std::env::set_var("DEBRIDLINK_API_BASE", value),
                None => std::env::remove_var("DEBRIDLINK_API_BASE"),
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum Scene {
    Happy,
    Episode,
    Stuck,
    MissingId,
    Failure,
    Mismatch,
}

pub(super) struct Rec {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) query: String,
    pub(super) content_type: String,
    pub(super) auth_ok: bool,
    pub(super) async_flag: bool,
    pub(super) has_hash: bool,
    pub(super) has_show: bool,
}

pub(super) struct Mock {
    pub(super) hits: AtomicU32,
    pub(super) bad: AtomicBool,
    scene: Scene,
    recs: Mutex<Vec<Rec>>,
}

async fn listen(mock: Arc<Mock>) -> std::net::SocketAddr {
    let app = Router::new().fallback(any(respond)).with_state(mock);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

async fn respond(State(mock): State<Arc<Mock>>, req: Request<Body>) -> Response {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let bearer = format!("Bearer {API_KEY}");
    let auth_ok = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(bearer.as_str());
    let content_type = req
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let raw = match req.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            mock.bad.store(true, Ordering::SeqCst);
            return fail("corpo");
        }
    };
    let body = String::from_utf8_lossy(&raw);
    let rec = Rec {
        method,
        path: path.clone(),
        query,
        content_type,
        auth_ok,
        async_flag: body.contains("async=true"),
        has_hash: body.contains(H1),
        has_show: body.contains(SHOW),
    };
    let list_n = {
        let mut recs = mock.recs.lock().unwrap();
        recs.push(rec);
        recs.iter()
            .filter(|item| item.path == "/seedbox/list")
            .count()
    };
    if path != "/seedbox/add" && path != "/seedbox/list" {
        mock.bad.store(true, Ordering::SeqCst);
        return fail("rota");
    }
    reply(mock.scene, &path, list_n)
}

fn reply(scene: Scene, path: &str, list_n: usize) -> Response {
    if path == "/seedbox/add" {
        return match scene {
            Scene::Happy => ok(json!({
                "id": "dl-item-42",
                "hash": H1,
                "name": "The.Matrix.1999.1080p.BluRay.x264",
                "downloadPercent": 50
            })),
            Scene::Episode => ok(json!({
                "id": "dl-series-1",
                "downloadPercent": 100,
                "files": named_files("Show.S01E02.1080p.mkv", S01E02)
            })),
            Scene::Stuck => ok(json!({"id": "dl-stuck", "downloadPercent": 20})),
            Scene::MissingId => ok(json!({})),
            Scene::Failure => fail("invalid api key"),
            Scene::Mismatch => ok(json!({
                "id": "dl-mismatch",
                "downloadPercent": 100,
                "files": named_files("Show.S01E03.1080p.mkv", S01E03)
            })),
        };
    }
    match scene {
        Scene::Happy => {
            let percent = if list_n >= 2 { 100 } else { 80 };
            let files = vec![
                file("The.Matrix.1999.1080p.mkv", 8_500_000_000, MATRIX),
                file("Sample.mkv", 50_000_000, SAMPLE),
            ];
            ok(json!([{
                "id": "dl-item-42",
                "hash": H1,
                "name": "The.Matrix.1999.1080p.BluRay.x264",
                "downloadPercent": percent,
                "files": files
            }]))
        }
        Scene::Stuck => ok(json!([{"id": "dl-stuck", "downloadPercent": 25}])),
        _ => fail("lista inesperada"),
    }
}

pub(super) const MATRIX: &str = "https://dl.test/stream/matrix-1080p.mkv";
const SAMPLE: &str = "https://dl.test/stream/sample.mkv";
const S01E01: &str = "https://dl.test/stream/s01e01.mkv";
pub(super) const S01E02: &str = "https://dl.test/stream/s01e02.mkv";
const S01E03: &str = "https://dl.test/stream/s01e03.mkv";

fn named_files(other: &str, url: &str) -> Value {
    Value::Array(vec![
        file("Show.S01E01.1080p.mkv", 1_200_000_000, S01E01),
        file(other, 1_200_000_000, url),
    ])
}

fn file(name: &str, size: u64, download_url: &str) -> Value {
    json!({"name": name, "size": size, "downloadUrl": download_url})
}

fn ok(value: Value) -> Response {
    (
        StatusCode::OK,
        Json(json!({"success": true, "value": value})),
    )
        .into_response()
}

fn fail(error: &str) -> Response {
    let body = json!({"success": false, "error": error});
    (StatusCode::OK, Json(body)).into_response()
}

pub(super) async fn harness(scene: Scene) -> (Arc<Mock>, DebridLink, EnvReset) {
    let mock = Arc::new(Mock {
        hits: AtomicU32::new(0),
        bad: AtomicBool::new(false),
        scene,
        recs: Mutex::new(Vec::new()),
    });
    let addr = listen(mock.clone()).await;
    let reset = EnvReset::set(&format!("http://{addr}")).await;
    let svc = DebridLink::new(crate::HttpClient::new().unwrap());
    (mock, svc, reset)
}

pub(super) fn snapshot(mock: &Mock) -> Vec<Rec> {
    mock.recs.lock().unwrap().drain(..).collect()
}

pub(super) fn of<'a>(recs: &'a [Rec], path: &str) -> Vec<&'a Rec> {
    recs.iter().filter(|rec| rec.path == path).collect()
}

pub(super) fn movie() -> PlayHint {
    PlayHint::default()
}

pub(super) fn episode(episode: i64) -> PlayHint {
    PlayHint {
        season: Some(1),
        episode: Some(episode),
        work: None,
    }
}

pub(super) async fn play(
    svc: &DebridLink,
    hint: &PlayHint,
    magnet: Option<&str>,
) -> Result<Option<String>, crate::DebridError> {
    svc.resolve_link(API_KEY, H1, hint, magnet, Duration::ZERO)
        .await
}

#[test]
fn base_so_https_ou_loopback() {
    let https = super::accepted_base("https://debrid-link.com/api/v2/").unwrap();
    assert_eq!(https, "https://debrid-link.com/api/v2");
    let local = super::accepted_base("http://127.0.0.1:9/").unwrap();
    assert_eq!(local, "http://127.0.0.1:9");
    assert!(super::accepted_base("http://localhost:9").is_ok());
    for rejected in [
        "http://example.com",
        "http://127.0.0.1.example.com",
        "ftp://127.0.0.1",
        "http://user@127.0.0.1",
    ] {
        let err = super::accepted_base(rejected).unwrap_err();
        assert_eq!(err.kind(), "other");
        assert!(!err.message().contains("Bearer"));
    }
}

#[test]
fn percent_ausente_nao_espera_e_magnet_exige_hash() {
    assert!(!super::percent_below_100(&json!({"id": "x"})));
    assert!(super::percent_below_100(&json!({"downloadPercent": 99})));
    assert!(!super::percent_below_100(&json!({"downloadPercent": 100})));
    assert!(super::percent_below_100(&json!({"downloadPercent": null})));
    let custom = "magnet:?xt=urn:btih:ab&dn=ok";
    assert_eq!(super::magnet_for("ab", Some(custom)), custom);
    let ignored = super::magnet_for("ab", Some("magnet:?xt=urn:btih:ff"));
    assert!(ignored.contains("urn:btih:ab"));
    assert!(ignored.starts_with("magnet:?"));
    let err = super::value_of(json!({"success": false})).unwrap_err();
    assert_eq!(err.message(), "debrid-link retornou erro");
    let raw = json!({"success": false, "error": "invalid api key"});
    let authish = super::value_of(raw).unwrap_err();
    assert_eq!(authish.kind(), "other");
    assert_eq!(authish.message(), "invalid api key");
}

#[tokio::test]
async fn check_cached_nao_faz_http() {
    let (mock, svc, _reset) = harness(Scene::Happy).await;
    let cached = svc.check_cached().await.unwrap();
    assert!(cached.is_empty());
    assert_eq!(mock.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn base_http_publica_nao_chama_a_rede() {
    let _reset = EnvReset::set("http://example.com").await;
    let svc = DebridLink::new(crate::HttpClient::new().unwrap());
    assert!(svc.base.is_empty());
    let err = svc
        .resolve_link("chave-de-teste-dl", H1, &movie(), None, Duration::ZERO)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "other");
    assert!(!err.message().contains("chave-de-teste-dl"));
    assert!(svc.check_cached().await.unwrap().is_empty());
}
