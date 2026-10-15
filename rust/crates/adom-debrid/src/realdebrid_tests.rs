//! Servidor falso em 127.0.0.1. Sem rede real e sem imprimir a chave.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::PlayHint;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::RealDebrid;
use crate::http::HttpClient;

pub(super) const KEY: &str = "rd-test-key";
const HASH: &str = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const HASH_UP: &str = "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD";
const DOWNLOAD: &str = "https://cdn.test/movie.mkv";
const TOKEN: &str = "RDTOKEN";

static ENV: Mutex<()> = Mutex::new(());

fn with_env<T>(base: Option<&str>, body: impl FnOnce() -> T) -> T {
    let _lock = ENV.lock().unwrap_or_else(|err| err.into_inner());
    let prev = std::env::var("REALDEBRID_API_BASE").ok();
    // SAFETY: o mutex serializa o acesso. A variável só aponta o adaptador
    // para o servidor local e é restaurada antes do lock soltar.
    unsafe {
        match base {
            Some(value) => std::env::set_var("REALDEBRID_API_BASE", value),
            None => std::env::remove_var("REALDEBRID_API_BASE"),
        }
    }
    let out = body();
    unsafe {
        match &prev {
            Some(value) => std::env::set_var("REALDEBRID_API_BASE", value),
            None => std::env::remove_var("REALDEBRID_API_BASE"),
        }
    }
    out
}

pub(super) fn open(addr: SocketAddr) -> RealDebrid {
    with_env(Some(&format!("http://{addr}")), || {
        RealDebrid::new(HttpClient::new().expect("cliente"))
    })
}

#[derive(Clone, Copy)]
pub(super) enum Scene {
    Idle,
    Blocked,
    Ready,
    Flow,
    NoVideo,
    Account,
    ActiveOk,
    ActiveBad,
    ActiveNan,
}

pub(super) struct Rec {
    method: String,
    pub(super) path: String,
    pub(super) query: String,
    auth_ok: bool,
    form: bool,
}

pub(super) struct Mock {
    pub(super) hits: AtomicU32,
    bad: AtomicBool,
    why: Mutex<String>,
    scene: Scene,
    info_n: AtomicU32,
    deletes: AtomicU32,
    pub(super) recs: Mutex<Vec<Rec>>,
}

pub(super) async fn listen(scene: Scene) -> (SocketAddr, Arc<Mock>) {
    let mock = Arc::new(Mock {
        hits: AtomicU32::new(0),
        bad: AtomicBool::new(false),
        why: Mutex::new(String::new()),
        scene,
        info_n: AtomicU32::new(0),
        deletes: AtomicU32::new(0),
        recs: Mutex::new(Vec::new()),
    });
    let app = Router::new()
        .fallback(any(respond))
        .with_state(mock.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, mock)
}

fn blame(mock: &Mock, reason: &str) {
    mock.bad.store(true, Ordering::SeqCst);
    *mock.why.lock().unwrap() = reason.to_string();
}

async fn respond(State(mock): State<Arc<Mock>>, req: Request<Body>) -> Response {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let bearer = format!("Bearer {KEY}");
    let auth_ok = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        == Some(bearer.as_str());
    let form = req
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .starts_with("application/x-www-form-urlencoded");
    let raw = req
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let body = String::from_utf8_lossy(&raw).to_string();
    if !auth_ok {
        blame(&mock, "auth");
    }
    if method == "POST" && !form {
        blame(&mock, "form");
    }
    if path.starts_with("/torrents/delete/") {
        mock.deletes.fetch_add(1, Ordering::SeqCst);
    }
    let info_n = if path.starts_with("/torrents/info/") {
        mock.info_n.fetch_add(1, Ordering::SeqCst) + 1
    } else {
        0
    };
    mock.recs.lock().unwrap().push(Rec {
        method: method.clone(),
        path: path.clone(),
        query,
        auth_ok,
        form,
    });
    dispatch(&mock, &method, &path, &body, info_n)
}

fn dispatch(mock: &Mock, method: &str, path: &str, body: &str, info_n: u32) -> Response {
    let miss = |why: &str| {
        blame(mock, why);
        StatusCode::NOT_FOUND.into_response()
    };
    match mock.scene {
        Scene::Idle => {
            blame(mock, "rota");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Scene::Blocked if method == "GET" && path == "/torrents" => json_ok(json!([])),
        Scene::Blocked if method == "POST" && path == "/torrents/addMagnet" => {
            if !body.contains(HASH) || !body.contains("opentrackr.org") {
                blame(mock, "magnet");
            }
            (StatusCode::UNAVAILABLE_FOR_LEGAL_REASONS, "infringing_file").into_response()
        }
        Scene::Ready if method == "GET" && path == "/torrents" => {
            json_ok(json!([{"id":"READY1","hash":HASH_UP,"status":"downloaded"}]))
        }
        Scene::Ready if method == "GET" && path == "/torrents/info/READY1" => downloaded(),
        Scene::Ready if method == "POST" && path == "/unrestrict/link" => {
            json_ok(json!({"download": DOWNLOAD}))
        }
        Scene::Flow if method == "GET" && path == "/torrents" => json_ok(json!([])),
        Scene::Flow if method == "POST" && path == "/torrents/addMagnet" => {
            if !body.contains(HASH) || !body.contains("KeepMe") {
                blame(mock, "magnet");
            }
            json_ok(json!({"id":"NEW1"}))
        }
        Scene::Flow if method == "GET" && path == "/torrents/info/NEW1" => {
            if info_n == 1 {
                waiting_files()
            } else {
                downloaded()
            }
        }
        Scene::Flow if method == "POST" && path == "/torrents/selectFiles/NEW1" => {
            if body != "files=2" {
                blame(mock, "files");
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Scene::Flow if method == "POST" && path == "/unrestrict/link" => {
            if !body.starts_with("link=") || !body.contains(TOKEN) {
                blame(mock, "link");
            }
            json_ok(json!({"download": DOWNLOAD}))
        }
        Scene::NoVideo if method == "GET" && path == "/torrents" => json_ok(json!([])),
        Scene::NoVideo if method == "POST" && path == "/torrents/addMagnet" => {
            json_ok(json!({"id":"NV1"}))
        }
        Scene::NoVideo if method == "GET" && path == "/torrents/info/NV1" => json_ok(json!({
            "status": "waiting_files_selection",
            "files": [{"id": 1, "path": "/notas.txt", "bytes": 12}]
        })),
        Scene::NoVideo if method == "DELETE" && path == "/torrents/delete/NV1" => {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Scene::Account if method == "GET" && path == "/user" => {
            json_ok(json!({"expiration": "2021-01-01T00:00:00.000Z"}))
        }
        Scene::Account if method == "GET" && path == "/torrents" => json_ok(json!([
            {"status":"downloaded"}, {"status":"downloaded"}, {"status":"queued"},
            {"status":"magnet_error"}, {"status":"ERROR"}, {"status":"virus"},
            {"status":"dead"}, {"status":"downloading"}
        ])),
        Scene::ActiveOk if path == "/torrents/activeCount" => {
            json_ok(json!({"nb": 4, "limit": 25}))
        }
        Scene::ActiveBad if path == "/torrents/activeCount" => {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
        Scene::ActiveNan if path == "/torrents/activeCount" => json_ok(json!({"limit": 3})),
        _ => miss("rota"),
    }
}

fn waiting_files() -> Response {
    json_ok(json!({
        "status": "waiting_files_selection",
        "files": [
            {"id": 2, "path": "/Film.2020.mkv", "bytes": 5000},
            {"id": 9, "path": "/notas.txt", "bytes": 10}
        ]
    }))
}

fn downloaded() -> Response {
    json_ok(json!({
        "status": "downloaded",
        "files": [{"id": 2, "path": "/Film.2020.mkv", "bytes": 5000, "selected": 1}],
        "links": [format!("https://real-debrid.com/d/{TOKEN}")]
    }))
}

fn json_ok(value: Value) -> Response {
    (StatusCode::OK, axum::Json(value)).into_response()
}

fn paths(mock: &Mock) -> Vec<String> {
    mock.recs
        .lock()
        .unwrap()
        .iter()
        .map(|rec| format!("{} {}", rec.method, rec.path))
        .collect()
}

pub(super) fn assert_clean(mock: &Mock) {
    assert!(
        !mock.bad.load(Ordering::SeqCst),
        "{}",
        mock.why.lock().unwrap()
    );
    assert!(mock.recs.lock().unwrap().iter().all(|rec| rec.auth_ok));
    assert!(mock
        .recs
        .lock()
        .unwrap()
        .iter()
        .all(|rec| rec.method != "POST" || rec.form));
}

async fn play(
    svc: &RealDebrid,
    magnet: Option<&str>,
) -> Result<Option<String>, crate::DebridError> {
    svc.resolve_link(KEY, HASH, &PlayHint::default(), magnet, Duration::ZERO)
        .await
}

#[tokio::test]
async fn check_cached_nao_faz_http_e_o_complete_segue_o_known() {
    let (addr, mock) = listen(Scene::Idle).await;
    let svc = open(addr);
    let unknown = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let miss = "cccccccccccccccccccccccccccccccccccccccc";
    let report = svc.check_cached(&[HASH_UP, unknown, miss, HASH], |hash| {
        assert_eq!(hash, hash.to_ascii_lowercase());
        if hash == HASH {
            Some(true)
        } else if hash == miss {
            Some(false)
        } else {
            None
        }
    });
    assert_eq!(report.cached, vec![HASH.to_string()]);
    assert!(!report.complete);
    let known = svc.check_cached(&[HASH, miss], |hash| Some(hash == HASH));
    assert_eq!(known.cached, vec![HASH.to_string()]);
    assert!(known.complete);
    assert_eq!(mock.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn add_magnet_451_e_blocked_sem_select_nem_unrestrict() {
    let (addr, mock) = listen(Scene::Blocked).await;
    let svc = open(addr);
    let err = play(&svc, Some("https://cdn.example/nope"))
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "blocked");
    assert_eq!(
        paths(&mock),
        vec![
            "GET /torrents".to_string(),
            "POST /torrents/addMagnet".to_string()
        ]
    );
    assert_clean(&mock);
}

#[tokio::test]
async fn torrent_baixado_pula_add_magnet() {
    let (addr, mock) = listen(Scene::Ready).await;
    let svc = open(addr);
    assert_eq!(play(&svc, None).await.unwrap().as_deref(), Some(DOWNLOAD));
    assert_eq!(
        paths(&mock),
        vec![
            "GET /torrents".to_string(),
            "GET /torrents/info/READY1".to_string(),
            "POST /unrestrict/link".to_string(),
        ]
    );
    assert_clean(&mock);
}

#[tokio::test]
async fn fluxo_select_files_204_e_unrestrict() {
    let (addr, mock) = listen(Scene::Flow).await;
    let svc = open(addr);
    let magnet = format!("magnet:?xt=urn:btih:{HASH}&dn=KeepMe");
    assert_eq!(
        play(&svc, Some(&magnet)).await.unwrap().as_deref(),
        Some(DOWNLOAD)
    );
    assert_eq!(
        paths(&mock),
        vec![
            "GET /torrents".to_string(),
            "POST /torrents/addMagnet".to_string(),
            "GET /torrents/info/NEW1".to_string(),
            "POST /torrents/selectFiles/NEW1".to_string(),
            "GET /torrents/info/NEW1".to_string(),
            "POST /unrestrict/link".to_string(),
        ]
    );
    assert_clean(&mock);
}

#[tokio::test]
async fn no_video_dispara_um_unico_delete() {
    let (addr, mock) = listen(Scene::NoVideo).await;
    let svc = open(addr);
    let err = play(&svc, None).await.unwrap_err();
    assert_eq!(err.kind(), "no_video");
    assert_eq!(mock.deletes.load(Ordering::SeqCst), 1);
    let seen = paths(&mock);
    assert!(!seen
        .iter()
        .any(|path| path.contains("selectFiles") || path.contains("unrestrict")));
    assert_clean(&mock);
}

#[test]
fn base_so_https_ou_loopback() {
    assert!(super::accepted_base("https://api.real-debrid.com/rest/1.0/").is_ok());
    assert!(super::accepted_base("http://127.0.0.1:9").is_ok());
    assert!(super::accepted_base("http://localhost:9").is_ok());
    assert!(super::accepted_base("http://example.com").is_err());
    let svc = with_env(Some("http://example.com"), || {
        RealDebrid::new(HttpClient::new().expect("cliente"))
    });
    assert!(svc.base.is_empty());
}
