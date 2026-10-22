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
    account_scope, adprot_key, adrm_key, adsub_key, hold, remember_submitted, reset_submitted,
    CleanupMode, CleanupSuppressed, DropVerdict, DurablePeek, Holds, Inventory,
};
use crate::alldebrid_delete::{delete_with_backoff, DeleteConfig, DeleteStop};
use crate::http::HttpClient;

const KEY: &str = "ad-cleanup-key";

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

#[test]
fn hold_volatil_expira_e_libera() {
    let registry = Holds::new();
    let account = account_scope("conta-do-hold");
    registry.hold(&account, "ABC", Duration::from_millis(30));
    assert!(registry.is_held(&account, "abc"), "hash normalizado");
    std::thread::sleep(Duration::from_millis(40));
    assert!(!registry.is_held(&account, "abc"));
}

#[tokio::test]
async fn hold_do_chamador_e_registro_volatil_protegem() {
    // Conta própria: outro teste não pode soltar o hold global deste.
    const HOLD_KEY: &str = "ad-cleanup-hold-shared";
    let account = account_scope(HOLD_KEY);
    // Hold volátil global: o autofetch em voo protege o hash 'b'.
    hold(&account, &hash_of('b'), Duration::from_secs(60));
    let scene = scene("ab", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = ad
        .check_cached(
            HOLD_KEY,
            &[hash_of('a'), hash_of('b'), hash_of('c')],
            &opts(true, true, Some(&[]), &[hash_of('a').as_str()], true, None),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert!(plan.ready.is_empty(), "a (held) e b (volátil) ficam");
    assert_eq!(plan.uncached.len(), 1);
    assert_eq!(plan.uncached[0].hash, hash_of('c'));
    assert_eq!(plan.protected, 2);
    crate::alldebrid_cleanup::release(&account, &hash_of('b'));
}

// ── knownBefore / inventário ────────────────────────────────────────────────

#[tokio::test]
async fn preexistente_do_snapshot_nao_apaga() {
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let known = [hash_of('a')];
    let report = ad
        .check_cached(
            KEY,
            &[hash_of('a'), hash_of('c')],
            &opts(
                true,
                true,
                Some(&known.iter().map(String::as_str).collect::<Vec<_>>()),
                &[],
                true,
                None,
            ),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert!(plan.ready.is_empty(), "acervo do usuário fica");
    assert_eq!(plan.known_before, 1);
    assert_eq!(plan.uncached.len(), 1);
    assert_eq!(plan.uncached[0].hash, hash_of('c'));
}

#[tokio::test]
async fn inventario_proprio_so_autoriza_com_snapshot() {
    // Conta própria: o snapshot global nasce vazio para esta chave.
    const OWNER: &str = "ad-cleanup-inventory-own";
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = ad
        .check_cached(
            OWNER,
            &[hash_of('a')],
            &opts(true, false, None, &[], true, None),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert_eq!(
        plan.suppressed,
        Some(CleanupSuppressed::InventoryMissing),
        "sem snapshot nesta rodada ninguém sai"
    );
    assert!(report.deleted.is_empty());
    assert_eq!(delete_hits(&scene), 0);
}

#[tokio::test]
async fn inventario_subtrai_adsub_e_submitted() {
    reset_submitted();
    let account = account_scope("ad-inventory-build");
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[adsub_key(&account, &hash_of('b'))]);
    let durable = DurablePeek::new(path);
    let scene = scene(
        "",
        &[
            hash_of('a').as_str(),
            hash_of('b').as_str(),
            hash_of('c').as_str(),
        ],
        DeleteMode::Ok,
    );
    let ad = open_scene(scene.clone()).await;
    remember_submitted(&account, &hash_of('c'));
    let inventory = Inventory::new(Duration::from_secs(60));
    let snapshot = inventory
        .load_now(&ad, KEY, &account, Some(&durable))
        .await
        .expect("snapshot");
    assert!(snapshot.contains(&hash_of('a')), "acervo do usuário");
    assert!(!snapshot.contains(&hash_of('b')), "adsub durável é nosso");
    assert!(!snapshot.contains(&hash_of('c')), "submitted é nosso");
}

// ── adprot durável / autofetch ──────────────────────────────────────────────

#[tokio::test]
async fn adprot_duravel_protege_o_acervo_br() {
    const ADPROT_KEY: &str = "ad-cleanup-adprot";
    let account = account_scope(ADPROT_KEY);
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[adprot_key(&account, &hash_of('a'))]);
    let durable = Arc::new(DurablePeek::new(path));
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = ad
        .check_cached(
            ADPROT_KEY,
            &[hash_of('a'), hash_of('c')],
            &opts(true, true, Some(&[]), &[], true, Some(durable)),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert!(plan.ready.is_empty(), "adprot segura o pronto");
    assert_eq!(plan.protected, 1);
    assert_eq!(plan.uncached.len(), 1, "o frio novo ainda sai");
}

#[tokio::test]
async fn autofetch_held_e_adprot_nao_saem_por_drop_uncached() {
    const AUTO_KEY: &str = "ad-cleanup-autofetch";
    let account = account_scope(AUTO_KEY);
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[adprot_key(&account, &hash_of('b'))]);
    let durable = Arc::new(DurablePeek::new(path));
    hold(&account, &hash_of('b'), Duration::from_secs(60));
    let scene = scene("", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = ad
        .check_cached(
            AUTO_KEY,
            &[hash_of('b')],
            &opts(false, true, Some(&[]), &[], true, Some(durable)),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert!(plan.uncached.is_empty(), "download do autofetch fica");
    assert_eq!(plan.protected, 1);
    assert_eq!(delete_hits(&scene), 0);
    crate::alldebrid_cleanup::release(&account, &hash_of('b'));
}

// ── dropReady / dropUncached ────────────────────────────────────────────────

#[tokio::test]
async fn drop_ready_e_drop_uncached_seguem_as_flags() {
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let hashes = [hash_of('a'), hash_of('c')];

    let both = ad
        .check_cached(KEY, &hashes, &opts(true, true, Some(&[]), &[], true, None))
        .await
        .unwrap()
        .cleanup
        .unwrap();
    assert_eq!(both.ready.len(), 1);
    assert_eq!(both.uncached.len(), 1);

    let ready_only = ad
        .check_cached(KEY, &hashes, &opts(true, false, Some(&[]), &[], true, None))
        .await
        .unwrap()
        .cleanup
        .unwrap();
    assert_eq!(ready_only.ready.len(), 1);
    assert!(ready_only.uncached.is_empty());

    let uncached_only = ad
        .check_cached(KEY, &hashes, &opts(false, true, Some(&[]), &[], true, None))
        .await
        .unwrap()
        .cleanup
        .unwrap();
    assert!(uncached_only.ready.is_empty());
    assert_eq!(uncached_only.uncached.len(), 1);
}

#[test]
fn classify_drop_fecha_o_fail_safe() {
    let account = "conta-classify";
    let gate = crate::alldebrid_cleanup::CleanupGate::new(
        true,
        true,
        true,
        HashSet::from(["aaa".to_string()]),
        None,
        account,
    );
    let empty = HashSet::new();
    let snapshot = HashSet::from(["bbb".to_string()]);
    assert_eq!(
        classify(&gate, None, "ccc"),
        DropVerdict::NoInventory,
        "sem inventário ninguém sai"
    );
    assert_eq!(
        classify(&gate, Some(&snapshot), "bbb"),
        DropVerdict::KnownBefore
    );
    assert_eq!(classify(&gate, Some(&empty), "aaa"), DropVerdict::Protected);
    assert!(matches!(
        classify(&gate, Some(&empty), "ccc"),
        DropVerdict::Delete(_)
    ));
}

fn classify(
    gate: &crate::alldebrid_cleanup::CleanupGate,
    inventory: Option<&HashSet<String>>,
    hash: &str,
) -> DropVerdict {
    crate::alldebrid_cleanup::classify_drop(gate, inventory, hash, "7", 0)
}

// ── Fila de delete: backoff, rodadas, quota/auth, kill-switch e gate ────────

#[tokio::test]
async fn backoff_retenta_na_mesma_rodada_e_na_segunda() {
    // Falha 2× (as duas tentativas da 1ª rodada) e sucede na 2ª rodada.
    let scene = scene("", &[], DeleteMode::FailTimes(2));
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        delays: vec![Duration::ZERO, Duration::ZERO],
        concurrency: 1,
        rounds: 2,
        kill: Some(false),
    };
    let report = delete_with_backoff(&ad, KEY, &["101".to_string()], config).await;
    assert_eq!(report.removed, vec!["101".to_string()]);
    assert!(report.failed.is_empty());
    assert_eq!(report.attempts, 3);
    let seen = hits(&scene);
    assert_eq!(seen.len(), 3);
    assert!(seen.iter().all(|hit| hit.auth_ok), "chave só no header");
    assert!(seen
        .iter()
        .all(|hit| values(&hit.query, "id") == vec!["101".to_string()]));
}

#[tokio::test]
async fn falha_persistente_vira_failed() {
    let scene = scene("", &[], DeleteMode::Always500);
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        delays: vec![Duration::ZERO, Duration::ZERO],
        concurrency: 4,
        rounds: 2,
        kill: Some(false),
    };
    let report = delete_with_backoff(&ad, KEY, &["101".to_string()], config).await;
    assert!(report.removed.is_empty());
    assert_eq!(report.failed, vec!["101".to_string()]);
    assert_eq!(report.attempts, 4);
    assert_eq!(report.stopped, None, "503/rede não é terminal");
}

#[tokio::test]
async fn quota_derruba_a_fila_e_nao_vira_unusable() {
    let scene = scene("", &[], DeleteMode::Quota);
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        delays: vec![Duration::ZERO, Duration::ZERO],
        concurrency: 1,
        rounds: 2,
        kill: Some(false),
    };
    let report = delete_with_backoff(
        &ad,
        KEY,
        &["101".to_string(), "102".to_string(), "103".to_string()],
        config,
    )
    .await;
    assert_eq!(report.stopped, Some(DeleteStop::Quota));
    assert!(report.removed.is_empty());
    assert_eq!(report.failed.len(), 3, "nenhum id some do relatório");
    assert_eq!(report.attempts, 1, "insistir em quota não gasta o teto");
    assert_eq!(delete_hits(&scene), 1);
}

#[tokio::test]
async fn rate_limit_usa_retry_after_e_continua() {
    let scene = scene("", &[], DeleteMode::RateThenOk);
    let ad = open_scene(scene.clone()).await;
    // O backoff configurado é longo; o `Retry-After: 0` vence e a fila não para.
    let config = DeleteConfig {
        delays: vec![Duration::from_secs(5), Duration::from_secs(5)],
        concurrency: 1,
        rounds: 1,
        kill: Some(false),
    };
    let report = delete_with_backoff(&ad, KEY, &["101".to_string()], config).await;
    assert_eq!(report.removed, vec!["101".to_string()]);
    assert_eq!(report.stopped, None, "rate limit é transitório");
    assert_eq!(report.attempts, 2);
}

#[tokio::test]
async fn kill_switch_para_a_fila() {
    let scene = scene("", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        kill: Some(true),
        ..DeleteConfig::fast()
    };
    let report = delete_with_backoff(&ad, KEY, &["101".to_string()], config).await;
    assert_eq!(report.stopped, Some(DeleteStop::KillSwitch));
    assert!(report.removed.is_empty());
    assert_eq!(delete_hits(&scene), 0);
}

#[tokio::test]
async fn uma_execucao_de_delete_por_conta() {
    let mut scene = Arc::try_unwrap(scene("", &[], DeleteMode::Ok))
        .ok()
        .unwrap();
    scene.slow_delete = Duration::from_millis(40);
    let scene = Arc::new(scene);
    let ad = open_scene(scene.clone()).await;
    let config = DeleteConfig {
        delays: Vec::new(),
        concurrency: 1,
        rounds: 1,
        kill: Some(false),
    };
    let ids_one = ["101".to_string()];
    let ids_two = ["102".to_string()];
    let one = delete_with_backoff(&ad, KEY, &ids_one, config.clone());
    let two = delete_with_backoff(&ad, KEY, &ids_two, config);
    let (first, second) = tokio::join!(one, two);
    assert_eq!(first.removed.len(), 1);
    assert_eq!(second.removed.len(), 1);
    assert_eq!(
        scene.max_inflight.load(Ordering::SeqCst),
        1,
        "o gate da conta serializa as execuções"
    );
    assert_eq!(delete_hits(&scene), 2);
}

#[tokio::test]
async fn delete_sem_ids_nao_pede_rede() {
    let scene = scene("", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = delete_with_backoff(
        &ad,
        KEY,
        &[],
        DeleteConfig {
            kill: Some(false),
            ..DeleteConfig::fast()
        },
    )
    .await;
    assert_eq!(report, crate::alldebrid_delete::DeleteReport::default());
    assert!(hits(&scene).is_empty());
}

#[test]
fn chave_da_protecao_bate_com_o_node() {
    let account = account_scope("minha-chave");
    assert_eq!(account.len(), 64);
    assert!(account.chars().all(|ch| ch.is_ascii_hexdigit()));
    assert_eq!(
        adprot_key(&account, "ABCD"),
        format!("adprot:v1:alldebrid:{account}:abcd")
    );
    assert_eq!(
        adsub_key(&account, "ABCD"),
        format!("adsub:v1:{account}:abcd")
    );
    // `adrm` NÃO leva segmento de adaptador (`alldebrid-reupload.ts::key`).
    assert_eq!(
        adrm_key(&account, "ABCD"),
        format!("adrm:v1:{account}:abcd")
    );
}

/// Anti-reenchimento (`adrm:v1`): a checagem só enxerga o bloqueio VIVO da
/// própria conta. Expirado, de outra conta ou de outro namespace não entra —
/// a fonte é read-only, então nada aqui pode gravar/apagar.
#[test]
fn blocked_hashes_so_devolve_adrm_vivo_da_propria_conta() {
    let account = account_scope("ad-adrm-conta");
    let outra = account_scope("ad-adrm-outra");
    let now = crate::error::now_ms() as i64;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
        )
        .unwrap();
        let rows = [
            (adrm_key(&account, &hash_of('a')), now + 60_000),
            (adrm_key(&account, &hash_of('b')), now - 1_000),
            (adrm_key(&outra, &hash_of('c')), now + 60_000),
            (adsub_key(&account, &hash_of('d')), now + 60_000),
        ];
        for (key, expires_at) in rows {
            conn.execute(
                "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
                rusqlite::params![key, expires_at],
            )
            .unwrap();
        }
    }
    let peek = DurablePeek::new(path);
    assert_eq!(
        peek.blocked_hashes(&account, now),
        HashSet::from([hash_of('a')]),
        "só o adrm vivo desta conta bloqueia o upload"
    );
}
