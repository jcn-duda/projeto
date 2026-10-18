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
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::{AccountStatus, AllDebrid, CheckOpts};
use crate::http::HttpClient;

pub(super) const API_KEY: &str = "ad-test-key";

struct EnvRestore {
    prev: Option<String>,
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        // SAFETY: `with_env` segura o mutex. A variável só aponta o adaptador
        // para o servidor local e é restaurada antes do lock soltar.
        unsafe {
            match &self.prev {
                Some(value) => std::env::set_var("ALLDEBRID_API_BASE", value),
                None => std::env::remove_var("ALLDEBRID_API_BASE"),
            }
        }
    }
}

fn with_env<T>(base: Option<&str>, body: impl FnOnce() -> T) -> T {
    let _lock = crate::test_env::lock();
    let _restore = EnvRestore {
        prev: std::env::var("ALLDEBRID_API_BASE").ok(),
    };
    unsafe {
        match base {
            Some(value) => std::env::set_var("ALLDEBRID_API_BASE", value),
            None => std::env::remove_var("ALLDEBRID_API_BASE"),
        }
    }
    body()
}

pub(super) fn open(addr: SocketAddr) -> AllDebrid {
    with_env(Some(&format!("http://{addr}")), || {
        AllDebrid::new(HttpClient::new().expect("cliente"))
    })
}

pub(super) struct Hit {
    method: String,
    pub(super) path: String,
    pub(super) query: String,
    pub(super) auth_ok: bool,
}

pub(super) struct Mock {
    hits: Mutex<Vec<Hit>>,
    upload: String,
    status_body: String,
    unlock: String,
    error_body: Option<String>,
    delete_status: u16,
}

pub(super) fn mock(upload: &str, status_body: &str, unlock: &str) -> Arc<Mock> {
    Arc::new(Mock {
        hits: Mutex::new(Vec::new()),
        upload: upload.into(),
        status_body: status_body.into(),
        unlock: unlock.into(),
        error_body: None,
        delete_status: 200,
    })
}

/// `/magnet/delete` responde 500; o resto como em `mock`.
pub(super) fn mock_delete_fails(upload: &str, status_body: &str) -> Arc<Mock> {
    let mut scene = Arc::try_unwrap(mock(upload, status_body, &empty_ok()))
        .ok()
        .unwrap();
    scene.delete_status = 500;
    Arc::new(scene)
}

pub(super) fn envelope(data: Value) -> String {
    json!({"status": "success", "data": data}).to_string()
}

pub(super) fn hash_of(ch: char) -> String {
    ch.to_string().repeat(40)
}

pub(super) fn empty_ok() -> String {
    envelope(json!({}))
}

pub(super) async fn listen(scene: Arc<Mock>) -> SocketAddr {
    let app = Router::new().fallback(any(respond)).with_state(scene);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

async fn respond(State(scene): State<Arc<Mock>>, req: Request<Body>) -> Response {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let bearer = format!("Bearer {API_KEY}");
    let auth_ok = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(bearer.as_str());
    scene.hits.lock().unwrap().push(Hit {
        method,
        path: path.clone(),
        query,
        auth_ok,
    });
    let _ = req.into_body().collect().await;
    if let Some(body) = &scene.error_body {
        return (StatusCode::OK, body.clone()).into_response();
    }
    if path.ends_with("/magnet/delete") && scene.delete_status != 200 {
        return (StatusCode::INTERNAL_SERVER_ERROR, "offline").into_response();
    }
    let body = if path.ends_with("/magnet/upload") {
        scene.upload.clone()
    } else if path.ends_with("/magnet/status") {
        scene.status_body.clone()
    } else if path.ends_with("/link/unlock") {
        scene.unlock.clone()
    } else {
        empty_ok()
    };
    (StatusCode::OK, body).into_response()
}

pub(super) fn hits(scene: &Mock) -> Vec<Hit> {
    scene.hits.lock().unwrap().drain(..).collect()
}

fn decode(raw: &str) -> String {
    let raw = raw.replace('+', " ");
    let bytes = raw.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or(""),
                16,
            ) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(super) fn values(query: &str, name: &str) -> Vec<String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (decode(key) == name).then(|| decode(value))
        })
        .collect()
}

fn sample_upload() -> String {
    let row =
        |ch: char, ready: bool, id: u64| json!({"hash": hash_of(ch), "ready": ready, "id": id});
    envelope(
        json!({"magnets": [row('a', true, 101), row('b', true, 102), row('c', false, 103), row('d', false, 104), row('e', false, 105)]}),
    )
}

fn cache_opts(loaded: bool) -> CheckOpts {
    CheckOpts {
        drop_ready: true,
        drop_uncached: true,
        inventory_loaded: loaded,
        held: HashSet::from([hash_of('b'), hash_of('d')]),
        known_before: HashSet::from([hash_of('e')]),
        blocked: HashSet::from([hash_of('f')]),
        ..CheckOpts::default()
    }
}

fn asked() -> Vec<String> {
    ['a', 'b', 'c', 'd', 'e', 'f']
        .into_iter()
        .map(hash_of)
        .collect()
}

#[test]
fn base_e_constantes() {
    let ad = with_env(None, || AllDebrid::new(HttpClient::new().unwrap()));
    assert_eq!(ad.base, "https://api.alldebrid.com/v4.1");
    let ad = with_env(Some("HTTPS://example.test/v4/"), || {
        AllDebrid::new(HttpClient::new().unwrap())
    });
    assert_eq!(ad.base, "https://example.test/v4");
    let ad = with_env(Some("http://127.0.0.1:9/"), || {
        AllDebrid::new(HttpClient::new().unwrap())
    });
    assert_eq!(ad.base, "http://127.0.0.1:9");
    let ad = with_env(Some("http://localhost:9/api"), || {
        AllDebrid::new(HttpClient::new().unwrap())
    });
    assert_eq!(ad.base, "http://localhost:9/api");
    let ad = with_env(Some("http://evil.test/api"), || {
        AllDebrid::new(HttpClient::new().unwrap())
    });
    assert!(ad.base.is_empty());
}

#[tokio::test]
async fn base_recusada_nao_pede_rede() {
    let ad = with_env(Some("http://evil.test"), || {
        AllDebrid::new(HttpClient::new().unwrap())
    });
    let err = ad
        .check_cached(API_KEY, &[], &CheckOpts::default())
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "other");
    assert!(err.message().contains("ALLDEBRID_API_BASE"));
}

#[tokio::test]
async fn upload_separa_cache_e_apaga_so_o_que_pode() {
    let scene = mock(&sample_upload(), &empty_ok(), &empty_ok());
    let ad = open(listen(scene.clone()).await);
    let report = ad
        .check_cached(API_KEY, &asked(), &cache_opts(true))
        .await
        .unwrap();
    assert_eq!(report.cached, vec![hash_of('a'), hash_of('b')]);
    assert!(report.complete);
    assert_eq!(report.deleted, vec!["101".to_string(), "103".to_string()]);
    let seen = hits(&scene);
    assert!(seen.iter().all(|hit| hit.auth_ok
        && hit.method == "GET"
        && hit.query.starts_with("agent=stremio-adom")));
    let upload: Vec<&Hit> = seen
        .iter()
        .filter(|hit| hit.path == "/magnet/upload")
        .collect();
    assert_eq!(upload.len(), 1);
    assert_eq!(
        values(&upload[0].query, "magnets[]"),
        asked()
            .into_iter()
            .filter(|hash| !hash.starts_with('f'))
            .collect::<Vec<_>>()
    );
    let deleted: Vec<&Hit> = seen
        .iter()
        .filter(|hit| hit.path == "/magnet/delete")
        .collect();
    assert_eq!(deleted.len(), 1);
    assert_eq!(
        values(&deleted[0].query, "id"),
        vec!["101".to_string(), "103".to_string()]
    );
}

#[tokio::test]
async fn inventario_fechado_nao_chama_delete() {
    let scene = mock(&sample_upload(), &empty_ok(), &empty_ok());
    let ad = open(listen(scene.clone()).await);
    let report = ad
        .check_cached(API_KEY, &asked(), &cache_opts(false))
        .await
        .unwrap();
    assert_eq!(report.cached, vec![hash_of('a'), hash_of('b')]);
    assert!(report.deleted.is_empty());
    assert!(hits(&scene).iter().all(|hit| hit.path != "/magnet/delete"));
}

#[tokio::test]
async fn status_error_classifica_auth_quota_e_deixa_o_resto_so_com_mensagem() {
    let cases = [
        (
            r#"{"status":"error","error":{"code":"AUTH_BAD_APIKEY","message":"chave recusada"}}"#,
            "auth",
            "chave recusada (AUTH_BAD_APIKEY)",
        ),
        (
            r#"{"status":"error","error":{"code":"MAGNET_TOO_MANY_ACTIVE","message":"cheio"}}"#,
            "quota",
            "cheio (MAGNET_TOO_MANY_ACTIVE)",
        ),
        (
            // Igual ao `batched` do TS: erro genérico do envelope vira "nenhum lote".
            r#"{"status":"error","error":{"code":"MAGNET_NOPE","message":"ruim"}}"#,
            "other",
            "nenhum lote de checagem de cache respondeu",
        ),
    ];
    for (body, kind, message) in cases {
        let scene = Arc::new(Mock {
            hits: Mutex::new(Vec::new()),
            upload: empty_ok(),
            status_body: empty_ok(),
            unlock: empty_ok(),
            error_body: Some(body.into()),
            delete_status: 200,
        });
        let ad = open(listen(scene).await);
        let err = ad
            .check_cached(API_KEY, &[hash_of('a')], &CheckOpts::default())
            .await
            .unwrap_err();
        assert_eq!(err.kind(), kind);
        assert_eq!(err.message(), message);
    }
}

#[tokio::test]
async fn falha_de_delete_nao_repete() {
    let scene = Arc::new(Mock {
        hits: Mutex::new(Vec::new()),
        upload: envelope(json!({"magnets": [{"hash": hash_of('c'), "ready": false, "id": 103}]})),
        status_body: empty_ok(),
        unlock: empty_ok(),
        error_body: None,
        delete_status: 500,
    });
    let ad = open(listen(scene.clone()).await);
    let opts = CheckOpts {
        drop_uncached: true,
        inventory_loaded: true,
        ..CheckOpts::default()
    };
    let err = ad
        .check_cached(API_KEY, &[hash_of('c')], &opts)
        .await
        .unwrap_err();
    assert_eq!(err.kind(), "other");
    let seen = hits(&scene);
    assert_eq!(
        seen.iter()
            .filter(|hit| hit.path == "/magnet/delete")
            .count(),
        1
    );
}

#[tokio::test]
async fn account_status_conta_estados_e_o_mais_antigo() {
    let body = envelope(json!({"magnets": [
        {"ready": true, "status": "Downloading", "uploadDate": 100},
        {"status": "ready", "uploadDate": 10},
        {"status": "Queued", "uploadDate": 40},
        {"status": "Failed", "uploadDate": 0},
        {"status": ""}
    ]}));
    let scene = mock(&empty_ok(), &body, &empty_ok());
    let ad = open(listen(scene.clone()).await);
    let got = ad.account_status(API_KEY).await.unwrap();
    assert_eq!(
        got,
        AccountStatus {
            magnets: 5,
            ready: 2,
            active: 1,
            error: 1,
            oldest_at: Some(10)
        }
    );
    let seen = hits(&scene);
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/magnet/status");
    assert_eq!(seen[0].query, "agent=stremio-adom");
    assert!(seen[0].auth_ok);
}
