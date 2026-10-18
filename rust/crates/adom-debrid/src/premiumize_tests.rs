//! Servidor falso em 127.0.0.1. Sem rede real e sem imprimir a chave.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use tokio::net::TcpListener;

use super::{AccountStatus, Premiumize, FILE_LIST_CAP};
use crate::http::HttpClient;

pub(super) const KEY: &str = "test-key";

fn restore(name: &str, prev: &Option<String>) {
    // SAFETY: o mutex de `with_env` serializa estes testes. A variável só aponta
    // o adaptador para o servidor local e é restaurada antes do lock soltar.
    unsafe {
        match prev {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
}

fn with_env<T>(base: Option<&str>, batch: Option<&str>, body: impl FnOnce() -> T) -> T {
    let _lock = crate::test_env::lock();
    let _restore = EnvRestore {
        base: std::env::var("PREMIUMIZE_API_BASE").ok(),
        batch: std::env::var("DEBRID_BATCH_SIZE").ok(),
    };
    unsafe {
        match base {
            Some(value) => std::env::set_var("PREMIUMIZE_API_BASE", value),
            None => std::env::remove_var("PREMIUMIZE_API_BASE"),
        }
        match batch {
            Some(value) => std::env::set_var("DEBRID_BATCH_SIZE", value),
            None => std::env::remove_var("DEBRID_BATCH_SIZE"),
        }
    }
    body()
}

struct EnvRestore {
    base: Option<String>,
    batch: Option<String>,
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        restore("PREMIUMIZE_API_BASE", &self.base);
        restore("DEBRID_BATCH_SIZE", &self.batch);
    }
}

pub(super) fn open(addr: SocketAddr) -> Premiumize {
    let base = format!("http://{addr}");
    with_env(Some(&base), None, || {
        Premiumize::new(HttpClient::new().expect("cliente"))
    })
}

#[derive(Clone)]
pub(super) struct Seen {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) query: String,
    pub(super) body: String,
    pub(super) content_type: String,
}

struct Scene {
    hits: Arc<Mutex<Vec<Seen>>>,
    status: u16,
    body: String,
    fail_query: Option<String>,
}

pub(super) async fn listen(
    status: u16,
    body: &str,
    fail_query: Option<&str>,
) -> (SocketAddr, Arc<Mutex<Vec<Seen>>>) {
    let hits = Arc::new(Mutex::new(Vec::new()));
    let scene = Arc::new(Scene {
        hits: hits.clone(),
        status,
        body: body.to_string(),
        fail_query: fail_query.map(str::to_string),
    });
    let app = Router::new().fallback(any(respond)).with_state(scene);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, hits)
}

async fn respond(State(scene): State<Arc<Scene>>, req: Request<Body>) -> Response {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
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
    scene.hits.lock().unwrap().push(Seen {
        method,
        path,
        query: query.clone(),
        body: String::from_utf8_lossy(&raw).into_owned(),
        content_type,
    });
    if scene
        .fail_query
        .as_ref()
        .is_some_and(|needle| query.contains(needle))
    {
        return (StatusCode::INTERNAL_SERVER_ERROR, "offline").into_response();
    }
    (
        StatusCode::from_u16(scene.status).unwrap(),
        scene.body.clone(),
    )
        .into_response()
}

fn items_of(query: &str) -> Vec<String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let key = key
                .replace("%5B", "[")
                .replace("%5D", "]")
                .replace("%5b", "[")
                .replace("%5d", "]");
            (key == "items[]").then(|| value.to_string())
        })
        .collect()
}

pub(super) fn hash_at(prefix: &str) -> String {
    prefix.repeat(20)
}

#[test]
fn base_e_lote_do_ambiente() {
    let pm = with_env(None, None, || Premiumize::new(HttpClient::new().unwrap()));
    assert_eq!(pm.base, "https://www.premiumize.me/api");
    assert_eq!(pm.batch_size, 25);
    let pm = with_env(Some("HTTPS://example.test/api/"), Some("7"), || {
        Premiumize::new(HttpClient::new().unwrap())
    });
    assert_eq!(pm.base, "https://example.test/api");
    assert_eq!(pm.batch_size, 7);
    let pm = with_env(Some("http://localhost:9/api/"), Some("0"), || {
        Premiumize::new(HttpClient::new().unwrap())
    });
    assert_eq!(pm.base, "http://localhost:9/api");
    assert_eq!(pm.batch_size, 25);
    let pm = with_env(Some("http://127.0.0.1:9"), None, || {
        Premiumize::new(HttpClient::new().unwrap())
    });
    assert_eq!(pm.base, "http://127.0.0.1:9");
    let pm = with_env(Some("http://evil.test/api"), None, || {
        Premiumize::new(HttpClient::new().unwrap())
    });
    assert!(pm.base.is_empty());
}

#[tokio::test]
async fn base_recusada_nao_pede_rede() {
    let pm = with_env(Some("http://evil.test"), None, || {
        Premiumize::new(HttpClient::new().unwrap())
    });
    let err = pm.check_cached(KEY, &[], None).await.unwrap_err();
    assert_eq!(err.kind(), "other");
    assert!(err.message().contains("PREMIUMIZE_API_BASE"));
}

#[test]
fn select_pula_known_e_respeita_o_teto() {
    let cached = vec![
        "AA".into(),
        "bb".into(),
        "CC".into(),
        "dd".into(),
        "ff".into(),
    ];
    let wanted: HashSet<String> = ["aa", "bb", "cc", "dd", "ff"]
        .into_iter()
        .map(str::to_string)
        .collect();
    let known: HashSet<String> = ["AA".into()].into_iter().collect();
    let flying: HashSet<String> = ["cc".into()].into_iter().collect();
    let got = Premiumize::select_file_list_hashes(&cached, &wanted, &known, &flying, FILE_LIST_CAP);
    assert_eq!(got, vec!["bb".to_string(), "dd".to_string()]);
}

#[tokio::test]
async fn cache_separa_lote_e_repete_items() {
    let h1 = hash_at("a1");
    let h2 = hash_at("b2");
    let body = r#"{"status":"success","response":[true,false],"filesize":[4096,0]}"#;
    let (addr, hits) = listen(200, body, None).await;
    let pm = open(addr);
    let report = pm
        .check_cached(KEY, &[h1.clone(), h2.clone()], None)
        .await
        .unwrap();
    assert_eq!(report.cached, vec![h1.clone()]);
    assert!(report.complete);
    assert_eq!(report.totals, vec![(h1.clone(), 4096)]);
    let seen = hits.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].method, "GET");
    assert_eq!(seen[0].path, "/cache/check");
    assert!(seen[0].body.is_empty());
    assert!(seen[0].query.starts_with("apikey=") && seen[0].query.contains(KEY));
    assert_eq!(items_of(&seen[0].query), vec![h1, h2]);
    assert!(!seen[0].query.contains(','));
}

#[tokio::test]
async fn status_200_classifica_auth_quota_e_rate() {
    let cases = [
        (
            r#"{"status":"error","message":"no","code":"authentication_failed"}"#,
            "auth",
            "no (authentication_failed)",
        ),
        (
            r#"{"status":"error","message":"no","code":"permission_denied"}"#,
            "auth",
            "no (permission_denied)",
        ),
        (
            r#"{"status":"error","message":"cheio","code":"account_limit_reached"}"#,
            "quota",
            "cheio (account_limit_reached)",
        ),
        (
            r#"{"status":"error","message":"devagar","code":"rate_limit_reached"}"#,
            "rate_limit",
            "devagar (rate_limit_reached)",
        ),
    ];
    let hash = hash_at("c3");
    for (body, kind, message) in cases {
        let (addr, _) = listen(200, body, None).await;
        let pm = open(addr);
        let err = pm
            .check_cached(KEY, std::slice::from_ref(&hash), None)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), kind);
        assert_eq!(err.message(), message);
        assert_eq!(err.retry_after_ms(), None);
        assert!(!err.message().contains(KEY));
    }
}

#[tokio::test]
async fn rede_em_todos_os_lotes_vira_outro() {
    let (addr, _) = listen(500, "offline", None).await;
    let pm = open(addr);
    let err = pm
        .check_cached(KEY, &[hash_at("d4")], None)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "other");
    assert_eq!(err.message(), "nenhum lote de checagem de cache respondeu");
}

#[tokio::test]
async fn lote_parcial_preserva_o_que_respondeu() {
    let h1 = hash_at("e5");
    let h2 = hash_at("f6");
    let body = r#"{"status":"success","response":[true],"filesize":[99]}"#;
    let (addr, hits) = listen(200, body, Some(&h2)).await;
    let mut pm = open(addr);
    pm.batch_size = 1;
    let report = pm.check_cached(KEY, &[h1.clone(), h2], None).await.unwrap();
    assert!(!report.complete);
    assert_eq!(report.cached, vec![h1.clone()]);
    assert_eq!(report.totals, vec![(h1, 99)]);
    assert_eq!(hits.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn conta_clampa_limite_e_ignora_premio_invalido() {
    let cases = [
        (
            r#"{"status":"success","limit_used":1.8,"premium_until":null}"#,
            Some(1.0),
            None,
        ),
        (
            r#"{"status":"success","limit_used":-0.2,"premium_until":1700000000}"#,
            Some(0.0),
            Some(1_700_000_000.0),
        ),
        (
            r#"{"status":"success","limit_used":0.25,"premium_until":0}"#,
            Some(0.25),
            Some(0.0),
        ),
        (
            r#"{"status":"success","limit_used":"nope","premium_until":"NaN"}"#,
            None,
            None,
        ),
    ];
    for (body, limit, until) in cases {
        let (addr, hits) = listen(200, body, None).await;
        let pm = open(addr);
        let status: AccountStatus = pm.account_status(KEY).await.unwrap();
        assert_eq!(status.limit_used, limit);
        assert_eq!(status.premium_until, until);
        let seen = hits.lock().unwrap().clone();
        assert_eq!(seen[0].path, "/account/info");
        assert_eq!(seen[0].method, "GET");
        assert!(seen[0].query.starts_with("apikey=") && seen[0].query.contains(KEY));
        assert!(seen[0].body.is_empty());
        assert!(!seen[0].body.contains(KEY));
    }
}
