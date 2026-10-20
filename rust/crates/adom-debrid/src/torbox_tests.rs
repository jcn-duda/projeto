//! Servidor falso em 127.0.0.1. Sem rede real e sem imprimir a chave.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use adom_core::PlayHint;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use tokio::net::TcpListener;

use super::{TorBox, ACTIVE_LIMIT};
use crate::http::HttpClient;

pub(super) const KEY: &str = "tb-test-key";
pub(super) const H1: &str = "abcdeabcdeabcdeabcdeabcdeabcdeabcdeabcde";
const H2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba";
const H3: &str = "abc3333333333333333333333333333333333333";

fn restore(name: &str, prev: &Option<String>) {
    // SAFETY: o mutex serializa o teste; a env só aponta o servidor local.
    unsafe {
        match prev {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
}

fn with_env<T>(base: Option<&str>, batch: Option<&str>, body: impl FnOnce() -> T) -> T {
    let _lock = crate::test_env::lock();
    let prev_base = std::env::var("TORBOX_API_BASE").ok();
    let prev_batch = std::env::var("DEBRID_BATCH_SIZE").ok();
    unsafe {
        match base {
            Some(value) => std::env::set_var("TORBOX_API_BASE", value),
            None => std::env::remove_var("TORBOX_API_BASE"),
        }
        match batch {
            Some(value) => std::env::set_var("DEBRID_BATCH_SIZE", value),
            None => std::env::remove_var("DEBRID_BATCH_SIZE"),
        }
    }
    let out = body();
    restore("TORBOX_API_BASE", &prev_base);
    restore("DEBRID_BATCH_SIZE", &prev_batch);
    out
}

pub(super) fn open(addr: SocketAddr) -> TorBox {
    let base = format!("http://{addr}");
    let mut svc = with_env(Some(&base), None, || {
        TorBox::new(HttpClient::new().expect("cliente"))
    });
    svc.batch_size = 25;
    svc
}

pub(super) fn movie() -> PlayHint {
    PlayHint::default()
}

#[derive(Clone, Copy)]
pub(super) enum Mode {
    Fixed,
    Check,
    Resolve(Kind),
    Account,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Happy,
    NoId,
    Stuck,
    NoVideo,
    DubLie,
}

pub(super) struct Hit {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) query: String,
    pub(super) body: String,
    pub(super) content_type: String,
    pub(super) auth_ok: bool,
    pub(super) token_ok: bool,
}

pub(super) struct Mock {
    pub(super) hits: Mutex<Vec<Hit>>,
    mode: Mode,
    status: u16,
    body: String,
    fail_query: Option<String>,
    mylist: AtomicU32,
}

pub(super) async fn listen(
    mode: Mode,
    status: u16,
    body: &str,
    fail_query: Option<&str>,
) -> (SocketAddr, Arc<Mock>) {
    let mock = Arc::new(Mock {
        hits: Mutex::new(Vec::new()),
        mode,
        status,
        body: body.to_string(),
        fail_query: fail_query.map(str::to_string),
        mylist: AtomicU32::new(0),
    });
    let app = Router::new()
        .fallback(any(respond))
        .with_state(mock.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, mock)
}

async fn respond(State(mock): State<Arc<Mock>>, req: Request<Body>) -> Response {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let bearer = format!("Bearer {KEY}");
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
    let raw = req
        .into_body()
        .collect()
        .await
        .map(|c| c.to_bytes())
        .unwrap_or_default();
    let token_ok = query.split('&').any(|pair| pair == format!("token={KEY}"));
    mock.hits.lock().unwrap().push(Hit {
        method,
        path: path.clone(),
        query: query.clone(),
        body: String::from_utf8_lossy(&raw).into_owned(),
        content_type,
        auth_ok,
        token_ok,
    });
    if mock
        .fail_query
        .as_ref()
        .is_some_and(|needle| query.contains(needle))
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "offline").into_response();
    }
    let (status, payload) = match mock.mode {
        Mode::Fixed => (mock.status, mock.body.clone()),
        Mode::Check => (200, check_body(&query)),
        Mode::Account => (200, account_body()),
        Mode::Resolve(kind) => (200, resolve_body(&mock, &path, kind)),
    };
    (StatusCode::from_u16(status).unwrap(), payload).into_response()
}

fn check_body(query: &str) -> String {
    if query.contains(H3) {
        let up = H3.to_ascii_uppercase();
        return format!(
            r#"{{"success":true,"data":{{"{up}":{{"files":[{{"name":"C.mkv","size":33}}]}}}}}}"#
        );
    }
    let h1 = H1.to_ascii_uppercase();
    format!(
        r#"{{"success":true,"data":[{{"hash":"{h1}","files":[{{"short_name":"A.mkv","name":"ignored.mkv","size":11}}]}},{{"hash":"{H2}","files":[{{"short_name":"B.mp4","name":"long.mkv","size":22}}]}}]}}"#
    )
}

fn account_body() -> String {
    r#"{"success":true,"data":[{"download_finished":true},{"download_state":"error","download_finished":true},{"download_state":"downloading"},{"download_state":"stalled"},{}]}"#.to_string()
}

fn ready_movie() -> String {
    r#"{"success":true,"data":{"download_present":true,"files":[{"id":7,"short_name":"Movie.2020.mkv","name":"other.mkv","size":1000}]}}"#.to_string()
}

fn dub_lie_movie() -> String {
    r#"{"success":true,"data":{"download_present":true,"files":[{"id":7,"short_name":"Movie.1080p.WEB-DL.x264-RARBG.mkv","name":"other.mkv","size":1000}]}}"#.to_string()
}

fn resolve_body(mock: &Mock, path: &str, kind: Kind) -> String {
    match path {
        "/torrents/createtorrent" => {
            if kind == Kind::NoId {
                r#"{"success":true,"data":{}}"#.to_string()
            } else {
                r#"{"success":true,"data":{"torrent_id":42}}"#.to_string()
            }
        }
        "/torrents/mylist" => {
            let n = mock.mylist.fetch_add(1, Ordering::SeqCst);
            match kind {
                Kind::Stuck => r#"{"success":true,"data":{"download_finished":false}}"#.to_string(),
                Kind::NoVideo => {
                    r#"{"success":true,"data":{"download_finished":true,"files":[{"id":1,"name":"readme.txt","size":10}]}}"#.to_string()
                }
                Kind::Happy if n == 0 => {
                    r#"{"success":true,"data":{"download_finished":false,"download_present":false}}"#.to_string()
                }
                Kind::Happy => ready_movie(),
                Kind::DubLie => dub_lie_movie(),
                Kind::NoId => r#"{"success":true,"data":{}}"#.to_string(),
            }
        }
        "/torrents/requestdl" => {
            r#"{"success":true,"data":{"url":"https://dl.test/movie.mkv"}}"#.to_string()
        }
        _ => r#"{"success":false,"error":"NOPE","detail":"rota"}"#.to_string(),
    }
}

#[test]
fn base_lote_e_constantes() {
    assert_eq!(ACTIVE_LIMIT, 10);
    let svc = with_env(None, None, || TorBox::new(HttpClient::new().unwrap()));
    assert_eq!(svc.base, "https://api.torbox.app/v1/api");
    assert_eq!(svc.batch_size, 25);
    let svc = with_env(Some("HTTPS://example.test/api/"), Some("7"), || {
        TorBox::new(HttpClient::new().unwrap())
    });
    assert_eq!(svc.base, "https://example.test/api");
    assert_eq!(svc.batch_size, 7);
    let svc = with_env(Some("http://localhost:9/api/"), Some("0"), || {
        TorBox::new(HttpClient::new().unwrap())
    });
    assert_eq!(svc.base, "http://localhost:9/api");
    assert_eq!(svc.batch_size, 25);
    let svc = with_env(Some("http://127.0.0.1:9"), None, || {
        TorBox::new(HttpClient::new().unwrap())
    });
    assert_eq!(svc.base, "http://127.0.0.1:9");
    let svc = with_env(Some("http://evil.test/api"), None, || {
        TorBox::new(HttpClient::new().unwrap())
    });
    assert!(svc.base.is_empty());
}

#[tokio::test]
async fn base_recusada_nao_pede_rede() {
    let svc = with_env(Some("http://evil.test"), None, || {
        TorBox::new(HttpClient::new().unwrap())
    });
    let err = svc
        .check_cached(KEY, &[H1.into()], &[], None)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "other");
    assert!(err.message().contains("TORBOX_API_BASE"));
    assert!(!err.message().contains(KEY));
}

#[tokio::test]
async fn success_false_active_limit_e_quota() {
    let cases = [
        (
            r#"{"success":false,"error":"ACTIVE_LIMIT","detail":"limite de ativos","data":[{"hash":"abc"}]}"#,
            "quota",
            "limite de ativos (ACTIVE_LIMIT)",
        ),
        (
            r#"{"success":false,"error":"MONTHLY_LIMIT"}"#,
            "quota",
            "MONTHLY_LIMIT",
        ),
        (
            r#"{"success":false,"error":"COOLDOWN_LIMIT","detail":"espere"}"#,
            "rate_limit",
            "espere (COOLDOWN_LIMIT)",
        ),
        (
            r#"{"success":false,"error":"SLOW","detail":"rate limit"}"#,
            "rate_limit",
            "rate limit (SLOW)",
        ),
        (
            // Igual ao `batched` do TS: erro genérico do envelope vira "nenhum lote".
            r#"{"success":false,"error":"BAD_HASH","detail":"hash ruim"}"#,
            "other",
            "nenhum lote de checagem de cache respondeu",
        ),
    ];
    for (body, kind, message) in cases {
        let (addr, _) = listen(Mode::Fixed, 200, body, None).await;
        let svc = open(addr);
        let err = svc
            .check_cached(KEY, &[H1.into()], &[], None)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), kind);
        assert_eq!(err.message(), message);
        assert_eq!(err.retry_after_ms(), None);
        assert!(!err.message().contains(KEY));
    }
}

#[tokio::test]
async fn check_lista_mapa_e_list_files() {
    let (addr, mock) = listen(Mode::Check, 200, "", None).await;
    let mut svc = open(addr);
    svc.batch_size = 2;
    let report = svc
        .check_cached(
            KEY,
            &[H1.into(), H2.into(), H3.into()],
            &[H2.to_ascii_uppercase()],
            None,
        )
        .await
        .unwrap();
    assert!(report.complete);
    assert_eq!(
        report.cached,
        vec![H1.to_string(), H2.to_string(), H3.to_string()]
    );
    assert_eq!(report.files.len(), 1);
    assert_eq!(report.files[0].0, H2);
    assert_eq!(report.files[0].1.len(), 1);
    assert_eq!(report.files[0].1[0].path, "B.mp4");
    assert_eq!(report.files[0].1[0].size, 22.0);
    let hits = mock.hits.lock().unwrap();
    assert!(hits
        .iter()
        .all(|hit| hit.auth_ok && hit.method == "GET" && hit.body.is_empty()));
    let wide = hits.iter().find(|hit| hit.query.contains(H1)).unwrap();
    let narrow = hits.iter().find(|hit| hit.query.contains(H3)).unwrap();
    assert_eq!(wide.path, "/torrents/checkcached");
    assert!(wide.query.contains("format=list"));
    assert!(wide.query.contains("list_files=true"));
    assert!(wide.query.contains(H2));
    assert_eq!(wide.query.matches("hash=").count(), 2);
    assert!(narrow.query.contains("list_files=false"));
    assert!(narrow.query.contains("format=list"));
    assert_eq!(narrow.query.matches("hash=").count(), 1);
    assert!(!report
        .files
        .iter()
        .any(|(hash, _)| hash == H1 || hash == H3));
}

#[tokio::test]
async fn lote_parcial_e_rede_em_todos() {
    let body = format!(r#"{{"success":true,"data":[{{"hash":"{H1}"}}]}}"#);
    let (addr, _) = listen(Mode::Fixed, 200, &body, Some(H2)).await;
    let mut svc = open(addr);
    svc.batch_size = 1;
    let report = svc
        .check_cached(KEY, &[H1.into(), H2.into()], &[], None)
        .await
        .unwrap();
    assert!(!report.complete);
    assert_eq!(report.cached, vec![H1.to_string()]);
    assert!(report.files.is_empty());
    let (addr, _) = listen(Mode::Fixed, 500, "offline", None).await;
    let svc = open(addr);
    let err = svc
        .check_cached(KEY, &[H1.into()], &[], None)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "other");
    assert_eq!(err.message(), "nenhum lote de checagem de cache respondeu");
}
