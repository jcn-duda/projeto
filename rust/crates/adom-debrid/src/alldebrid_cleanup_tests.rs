//! Fixtures da limpeza segura da AllDebrid: flag/kill-switch, hold volátil,
//! `adprot`/`adsub` duráveis, `knownBefore`, `dropReady`/`dropUncached` e a
//! fila de delete (backoff, segunda rodada, quota/auth e serialização).
//!
//! O servidor falso é loopback; nenhuma chamada vai para a AllDebrid real.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::alldebrid::AllDebrid;
use crate::alldebrid_cleanup::{
    account_scope, adhold_key, adprot_key, adrm_key, adsub_key, hold, remember_submitted,
    reset_submitted, CleanupMode, CleanupSuppressed, DropVerdict, DurablePeek, Holds, Inventory,
};
use crate::alldebrid_delete::{delete_with_backoff, DeleteConfig, DeleteStop};
use crate::http::HttpClient;

const KEY: &str = "ad-cleanup-key";
/// Nome que o `/magnet/upload` dublê devolve; viaja até o `adrm` do Node.
const UPLOAD_NAME: &str = "Alvo da limpeza 2024 1080p";

fn hash_of(ch: char) -> String {
    ch.to_string().repeat(40)
}

fn id_of(hash: &str) -> String {
    (hash.chars().next().unwrap_or('?') as u32).to_string()
}

#[derive(Clone)]
enum DeleteMode {
    Ok,
    /// As próximas N chamadas falham com 500; depois sucede.
    FailTimes(usize),
    Always500,
    Quota,
    /// A primeira chamada responde 429 com `Retry-After: 0`; depois sucede.
    RateThenOk,
}

struct Scene {
    ready: HashSet<char>,
    status: Vec<String>,
    delete: Mutex<DeleteMode>,
    hits: Mutex<Vec<Hit>>,
    deletes: AtomicUsize,
    inflight: AtomicUsize,
    max_inflight: AtomicUsize,
    slow_delete: Duration,
    rate_used: AtomicBool,
}

struct Hit {
    path: String,
    query: String,
    auth_ok: bool,
}

fn scene(ready: &str, status: &[&str], delete: DeleteMode) -> Arc<Scene> {
    Arc::new(Scene {
        ready: ready.chars().collect(),
        status: status.iter().map(|hash| (*hash).to_string()).collect(),
        delete: Mutex::new(delete),
        hits: Mutex::new(Vec::new()),
        deletes: AtomicUsize::new(0),
        inflight: AtomicUsize::new(0),
        max_inflight: AtomicUsize::new(0),
        slow_delete: Duration::ZERO,
        rate_used: AtomicBool::new(false),
    })
}

fn envelope(data: Value) -> String {
    json!({ "status": "success", "data": data }).to_string()
}

async fn listen(scene: Arc<Scene>) -> SocketAddr {
    let app = Router::new().fallback(any(respond)).with_state(scene);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

fn open(addr: SocketAddr) -> AllDebrid {
    let _lock = crate::test_env::lock();
    let previous = std::env::var("ALLDEBRID_API_BASE").ok();
    unsafe { std::env::set_var("ALLDEBRID_API_BASE", format!("http://{addr}")) };
    let ad = AllDebrid::new(HttpClient::new().unwrap());
    unsafe {
        match previous {
            Some(value) => std::env::set_var("ALLDEBRID_API_BASE", value),
            None => std::env::remove_var("ALLDEBRID_API_BASE"),
        }
    }
    ad
}

async fn open_scene(scene: Arc<Scene>) -> AllDebrid {
    open(listen(scene).await)
}

async fn respond(State(scene): State<Arc<Scene>>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let bearer = format!("Bearer {KEY}");
    let auth_ok = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(bearer.as_str());
    let _ = req.into_body().collect().await;
    scene.hits.lock().unwrap().push(Hit {
        path: path.clone(),
        query: query.clone(),
        auth_ok,
    });
    if path.ends_with("/magnet/delete") {
        scene.deletes.fetch_add(1, Ordering::SeqCst);
        let now = scene.inflight.fetch_add(1, Ordering::SeqCst) + 1;
        scene.max_inflight.fetch_max(now, Ordering::SeqCst);
        if !scene.slow_delete.is_zero() {
            tokio::time::sleep(scene.slow_delete).await;
        }
        scene.inflight.fetch_sub(1, Ordering::SeqCst);
        return delete_response(&scene);
    }
    if path.ends_with("/magnet/upload") {
        let list: Vec<Value> = values(&query, "magnets[]")
            .into_iter()
            .map(|hash| {
                let first = hash.chars().next().unwrap_or('?');
                json!({
                    "hash": hash,
                    "ready": scene.ready.contains(&first),
                    "id": id_of(&hash),
                    // Nome da release: vai com o alvo até o `adrm` do Node.
                    "name": UPLOAD_NAME,
                })
            })
            .collect();
        return (StatusCode::OK, envelope(json!({ "magnets": list }))).into_response();
    }
    if path.ends_with("/magnet/status") {
        let list: Vec<Value> = scene
            .status
            .iter()
            .map(|hash| json!({ "hash": hash }))
            .collect();
        return (StatusCode::OK, envelope(json!({ "magnets": list }))).into_response();
    }
    (StatusCode::OK, envelope(json!({}))).into_response()
}

fn delete_response(scene: &Scene) -> Response {
    let mode = scene.delete.lock().unwrap().clone();
    match mode {
        DeleteMode::Ok => (StatusCode::OK, envelope(json!({}))).into_response(),
        DeleteMode::FailTimes(left) => {
            if left > 0 {
                *scene.delete.lock().unwrap() = DeleteMode::FailTimes(left - 1);
                (StatusCode::INTERNAL_SERVER_ERROR, "offline").into_response()
            } else {
                (StatusCode::OK, envelope(json!({}))).into_response()
            }
        }
        DeleteMode::Always500 => (StatusCode::INTERNAL_SERVER_ERROR, "offline").into_response(),
        DeleteMode::Quota => (
            StatusCode::OK,
            json!({"status":"error","error":{"code":"MAGNET_TOO_MANY_ACTIVE","message":"cheio"}})
                .to_string(),
        )
            .into_response(),
        DeleteMode::RateThenOk => {
            if !scene.rate_used.swap(true, Ordering::SeqCst) {
                let mut response = (StatusCode::TOO_MANY_REQUESTS, "slow down").into_response();
                response
                    .headers_mut()
                    .insert("retry-after", "0".parse().unwrap());
                response
            } else {
                (StatusCode::OK, envelope(json!({}))).into_response()
            }
        }
    }
}

fn values(query: &str, name: &str) -> Vec<String> {
    query
        .split('&')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (decode(key) == name).then(|| decode(value))
        })
        .collect()
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

fn hits(scene: &Scene) -> Vec<Hit> {
    std::mem::take(&mut *scene.hits.lock().unwrap())
}

fn delete_hits(scene: &Scene) -> usize {
    hits(scene)
        .iter()
        .filter(|hit| hit.path.ends_with("/magnet/delete"))
        .count()
}

fn opts(
    drop_ready: bool,
    drop_uncached: bool,
    inventory: Option<&[&str]>,
    held: &[&str],
    holds_complete: bool,
    durable: Option<Arc<DurablePeek>>,
) -> crate::alldebrid::CheckOpts {
    crate::alldebrid::CheckOpts {
        batch_size: Some(25),
        timeout: Some(Duration::from_millis(2_000)),
        cleanup: CleanupMode::On,
        drop_ready,
        drop_uncached,
        inventory_loaded: inventory.is_some(),
        known_before: inventory
            .unwrap_or(&[])
            .iter()
            .map(|hash| (*hash).to_string())
            .collect(),
        held: held.iter().map(|hash| (*hash).to_string()).collect(),
        holds_complete,
        durable,
        kill_switch: Some(false),
        ..crate::alldebrid::CheckOpts::default()
    }
}

struct EnvGuard {
    saved: Vec<(&'static str, Option<String>)>,
    _lock: MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn set(pairs: &[(&'static str, &str)]) -> Self {
        let lock = crate::test_env::lock();
        let saved = pairs
            .iter()
            .map(|(name, value)| {
                let previous = std::env::var(name).ok();
                unsafe { std::env::set_var(name, value) };
                (*name, previous)
            })
            .collect();
        Self { saved, _lock: lock }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (name, previous) in &self.saved {
            unsafe {
                match previous {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

fn cache_db(dir: &Path, rows: &[String]) -> PathBuf {
    let path = dir.join("cache.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
    )
    .unwrap();
    let expires = crate::error::now_ms() as i64 + 60_000;
    for key in rows {
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params![key, expires],
        )
        .unwrap();
    }
    path
}

// ── Flag, kill-switch e holds ───────────────────────────────────────────────

#[tokio::test]
async fn flag_off_nao_apaga_nem_carrega_inventario() {
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let mut options = opts(true, true, Some(&[]), &[], true, None);
    options.cleanup = CleanupMode::Off;
    let report = ad
        .check_cached(KEY, &[hash_of('a'), hash_of('c')], &options)
        .await
        .unwrap();
    assert!(report.cleanup.is_none(), "flag OFF não produz plano");
    assert!(report.deleted.is_empty());
    assert!(hits(&scene)
        .iter()
        .all(|hit| !hit.path.ends_with("/magnet/delete")));
}

#[tokio::test]
async fn holds_incompletos_suprimem_o_plano() {
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let options = opts(true, true, Some(&[]), &[], false, None);
    let report = ad
        .check_cached(KEY, &[hash_of('a'), hash_of('c')], &options)
        .await
        .unwrap();
    let plan = report.cleanup.expect("flag ON produz plano");
    assert_eq!(plan.suppressed, Some(CleanupSuppressed::HoldsIncomplete));
    assert!(plan.is_empty());
    assert!(report.deleted.is_empty());
    assert_eq!(delete_hits(&scene), 0);
}

#[tokio::test]
async fn kill_switch_suprime_o_plano() {
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let mut options = opts(true, true, Some(&[]), &[], true, None);
    options.kill_switch = Some(true);
    let report = ad
        .check_cached(KEY, &[hash_of('a')], &options)
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert_eq!(plan.suppressed, Some(CleanupSuppressed::KillSwitch));
    assert_eq!(delete_hits(&scene), 0);
}

#[test]
fn kill_switch_env_e_parse() {
    {
        let _env = EnvGuard::set(&[("DEBRID_AL_CLEANUP_KILL", "on")]);
        assert!(crate::alldebrid_cleanup::kill_switch_on());
    }
    {
        let _env = EnvGuard::set(&[("DEBRID_AL_CLEANUP_KILL", "off")]);
        assert!(!crate::alldebrid_cleanup::kill_switch_on());
    }
}

#[path = "alldebrid_cleanup_tests_part2.rs"]
mod part2;

#[path = "alldebrid_cleanup_tests_part3.rs"]
mod part3;

#[path = "alldebrid_cleanup_tests_part4.rs"]
mod part4;
