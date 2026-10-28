//! Portas do autofetch contra um servidor falso em 127.0.0.1.
//!
//! O mock é genérico de propósito: casa `"MÉTODO /caminho"` e devolve
//! `(status, corpo)`. Os helpers de mock dos outros módulos são privados dos
//! pais deles (`pub(super)`), então não dá para reaproveitar sem abrir a
//! visibilidade do crate inteiro por causa de teste.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use serde_json::json;
use tokio::net::TcpListener;

use super::*;
use crate::http::HttpClient;

const KEY: &str = "ad-port-key";

struct Hit {
    path: String,
    body: String,
}

struct Mock {
    hits: Mutex<Vec<Hit>>,
    routes: Vec<(String, u16, String)>,
    fallback: (u16, String),
}

type Scene = Arc<Mock>;

async fn listen(routes: Vec<(&str, u16, String)>, fallback: (u16, String)) -> (SocketAddr, Scene) {
    let scene = Arc::new(Mock {
        hits: Mutex::new(Vec::new()),
        routes: routes
            .into_iter()
            .map(|(route, status, body)| (route.to_string(), status, body))
            .collect(),
        fallback,
    });
    let app = Router::new()
        .fallback(any(respond))
        .with_state(scene.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, scene)
}

async fn respond(State(scene): State<Scene>, req: Request<Body>) -> Response {
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let bytes = req
        .into_body()
        .collect()
        .await
        .map(|body| body.to_bytes())
        .unwrap_or_default();
    scene.hits.lock().unwrap().push(Hit {
        path: path.clone(),
        body: String::from_utf8_lossy(&bytes).to_string(),
    });
    let key = format!("{method} {path}");
    let (status, payload) = scene
        .routes
        .iter()
        .find(|(route, ..)| *route == key)
        .map(|(_, status, body)| (*status, body.clone()))
        .unwrap_or_else(|| scene.fallback.clone());
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        payload,
    )
        .into_response()
}

/// Base do adaptador em loopback; a env é restaurada antes de soltar a trava.
fn with_env<T>(name: &str, value: &str, body: impl FnOnce() -> T) -> T {
    let _lock = crate::test_env::lock();
    let prev = std::env::var(name).ok();
    unsafe {
        std::env::set_var(name, value);
    }
    let out = body();
    unsafe {
        match prev {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
    out
}

fn base(addr: SocketAddr) -> String {
    format!("http://{addr}")
}

fn alldebrid(addr: SocketAddr) -> Arc<AllDebrid> {
    Arc::new(with_env("ALLDEBRID_API_BASE", &base(addr), || {
        AllDebrid::new(HttpClient::new().unwrap())
    }))
}

fn torbox(addr: SocketAddr) -> Arc<TorBox> {
    Arc::new(with_env("TORBOX_API_BASE", &base(addr), || {
        TorBox::new(HttpClient::new().unwrap())
    }))
}

fn premiumize(addr: SocketAddr) -> Arc<Premiumize> {
    Arc::new(with_env("PREMIUMIZE_API_BASE", &base(addr), || {
        Premiumize::new(HttpClient::new().unwrap())
    }))
}

fn hash_of(ch: char) -> String {
    ch.to_string().repeat(40)
}

fn candidate(hash: &str) -> PortCandidate {
    PortCandidate::new(hash)
}

/// `cache.db` do Node (`key`/`value`/`expires_at`) vazio: guarda `adrm` limpa.
fn cache_db() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
    )
    .unwrap();
    (dir, path)
}

fn envelope(data: serde_json::Value) -> String {
    json!({ "status": "success", "data": data }).to_string()
}

fn hits(scene: &Scene) -> usize {
    scene.hits.lock().unwrap().len()
}

#[tokio::test]
async fn enqueue_alldebrid_aceito_devolve_id_do_upload() {
    let hash = hash_of('a');
    let body = envelope(json!({"magnets": [{"id": 77, "hash": hash, "ready": true}]}));
    let (addr, scene) = listen(vec![("GET /magnet/upload", 200, body)], (404, "{}".into())).await;
    let (_dir, db_path) = cache_db();
    let port = AutofetchPorts::alldebrid(
        alldebrid(addr),
        KEY,
        AlldebridFacts {
            db_path: Some(db_path),
            ..AlldebridFacts::default()
        },
    );
    let evidence = port.enqueue(&candidate(&hash)).await.unwrap();
    assert!(evidence.accepted);
    assert_eq!(evidence.transfer_id.as_deref(), Some("77"));
    assert_eq!(hits(&scene), 1);
    // A chave não sai na URL: ela vai no header Authorization do adaptador.
    assert!(!scene.hits.lock().unwrap()[0].body.contains(KEY));
}

#[tokio::test]
async fn enqueue_alldebrid_recusado_nao_alega_aceite() {
    let hash = hash_of('b');
    let body = envelope(json!({ "magnets": [] }));
    let (addr, scene) = listen(vec![("GET /magnet/upload", 200, body)], (404, "{}".into())).await;
    let (_dir, db_path) = cache_db();
    let port = AutofetchPorts::alldebrid(
        alldebrid(addr),
        KEY,
        AlldebridFacts {
            db_path: Some(db_path),
            ..AlldebridFacts::default()
        },
    );
    let evidence = port.enqueue(&candidate(&hash)).await.unwrap();
    assert_eq!(
        evidence,
        EnqueueEvidence {
            accepted: false,
            transfer_id: None
        }
    );
    // A requisição saiu (a recusa é do serviço), mas o hash não entrou.
    assert_eq!(hits(&scene), 1);
}

#[tokio::test]
async fn enqueue_alldebrid_sem_cache_db_nao_pede_rede() {
    let hash = hash_of('c');
    let (addr, scene) = listen(vec![], (500, "{}".into())).await;
    let port = AutofetchPorts::alldebrid(alldebrid(addr), KEY, AlldebridFacts::default());
    let evidence = port.enqueue(&candidate(&hash)).await.unwrap();
    assert!(!evidence.accepted, "sem guarda legível nada é enviado");
    assert_eq!(hits(&scene), 0);
}

#[tokio::test]
async fn status_alldebrid_pronto_morto_e_nao_listado_sao_distintos() {
    let (a, b, c) = (hash_of('a'), hash_of('b'), hash_of('c'));
    let body = envelope(json!({"magnets": [
        {"id": 1, "hash": a, "status": "Ready"},
        {"id": 2, "hash": b, "status": "expired"},
    ]}));
    let (addr, _scene) = listen(vec![("GET /magnet/status", 200, body)], (404, "{}".into())).await;
    let port = AutofetchPorts::alldebrid(alldebrid(addr), KEY, AlldebridFacts::default());
    let ids = std::collections::BTreeMap::new();
    let status = port
        .status(&[a.clone(), b.clone(), c.clone()], &ids)
        .await
        .unwrap();
    assert_eq!(status[&a].state, "ready");
    assert_eq!(status[&a].transfer_id.as_deref(), Some("1"));
    assert_eq!(status[&b].state, "dead");
    // O que não foi listado NÃO é morte: é desconhecido.
    assert_eq!(status[&c].state, "unknown");
    assert!(
        !status[&c].via_id,
        "sem id do chamador não há identificação"
    );
}

#[tokio::test]
async fn status_torbox_nao_listado_e_estado_ignorado_ficam_desconhecidos() {
    let (a, b, c) = (hash_of('a'), hash_of('b'), hash_of('c'));
    let body = json!({"success": true, "data": [
        {"id": 1, "hash": a, "download_state": "semeando_no_escuro"},
        {"id": 2, "hash": b, "download_state": "error"},
    ]})
    .to_string();
    let (addr, _scene) = listen(
        vec![("GET /torrents/mylist", 200, body)],
        (404, "{}".into()),
    )
    .await;
    let port = AutofetchPorts::torbox(torbox(addr), KEY);
    let ids = std::collections::BTreeMap::new();
    let status = port
        .status(&[a.clone(), b.clone(), c.clone()], &ids)
        .await
        .unwrap();
    assert_eq!(
        status[&a].state, "unknown",
        "estado não reconhecido não condena"
    );
    assert_eq!(status[&b].state, "dead");
    assert_eq!(status[&c].state, "unknown");
}

#[tokio::test]
async fn remove_torbox_id_fora_do_formato_nao_escreve() {
    let (addr, scene) = listen(vec![], (204, String::new())).await;
    let port = AutofetchPorts::torbox(torbox(addr), KEY);
    assert!(!port.remove("../seedbox/9").await.unwrap());
    assert_eq!(hits(&scene), 0);
}

#[tokio::test]
async fn remove_alldebrid_com_id_valido_pede_o_delete() {
    let (addr, scene) = listen(
        vec![("GET /magnet/delete", 200, envelope(json!({})))],
        (404, "{}".into()),
    )
    .await;
    let port = AutofetchPorts::alldebrid(alldebrid(addr), KEY, AlldebridFacts::default());
    assert!(port.remove("42").await.unwrap());
    assert_eq!(scene.hits.lock().unwrap()[0].path, "/magnet/delete");
}

#[tokio::test]
async fn check_premiumize_prova_hit_e_nao_conta_miss_como_frio() {
    let (a, b) = (hash_of('a'), hash_of('b'));
    let body =
        json!({"status": "success", "response": [true, false], "filesize": [10, 0]}).to_string();
    let (addr, _scene) = listen(vec![("GET /cache/check", 200, body)], (404, "{}".into())).await;
    let port = AutofetchPorts::premiumize(premiumize(addr), KEY);
    let evidence = port.check(&[a.clone(), b.clone()]).await.unwrap();
    assert!(evidence.known);
    assert_eq!(evidence.cached, vec![a]);
}

#[path = "autofetch_ports_tests_part2.rs"]
mod part2;

#[path = "autofetch_ports_evict_tests.rs"]
mod evict;

#[path = "autofetch_ports_evict_tests_part2.rs"]
mod evict_part2;
