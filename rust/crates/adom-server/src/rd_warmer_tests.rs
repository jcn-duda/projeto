//! Testes do aquecimento do RD: régua do Node, teto, dedupe, chave do cofre e
//! um HTTP falso que exercita a sonda real (`GateWarm` + `RealDebridAutofetch`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use super::*;

const HASH_READY: &str = "1111111111111111111111111111111111111111";
const HASH_DOWN: &str = "2222222222222222222222222222222222222222";
const HASH_ERR: &str = "3333333333333333333333333333333333333333";
const HASH_OTHER: &str = "4444444444444444444444444444444444444444";

fn payload(hashes: &[&str]) -> Value {
    let releases: Vec<Value> = hashes
        .iter()
        .map(|hash| json!({ "title": "t", "infoHash": hash, "isBr": true, "dubbed": true }))
        .collect();
    json!({ "releases": releases })
}

struct FakeKey {
    key: Option<String>,
    calls: AtomicUsize,
}

impl FakeKey {
    fn some(key: &str) -> Arc<Self> {
        Arc::new(Self {
            key: Some(key.to_string()),
            calls: AtomicUsize::new(0),
        })
    }

    fn none() -> Arc<Self> {
        Arc::new(Self {
            key: None,
            calls: AtomicUsize::new(0),
        })
    }
}

impl WarmKey for FakeKey {
    fn rd_key(&self, _now_ms: i64) -> Option<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.key.clone()
    }
}

#[derive(Default)]
struct FakeLedger {
    marks: Mutex<HashMap<String, LedgerMark>>,
    notes: Mutex<Vec<(String, WarmSignal)>>,
}

impl FakeLedger {
    fn hit(self: &Arc<Self>, hash: &str) {
        self.marks
            .lock()
            .unwrap()
            .insert(hash.to_string(), LedgerMark::Hit);
    }

    fn noted(&self) -> Vec<(String, WarmSignal)> {
        self.notes.lock().unwrap().clone()
    }
}

impl WarmLedger for FakeLedger {
    fn state(&self, hash: &str, _now_ms: i64) -> LedgerMark {
        *self
            .marks
            .lock()
            .unwrap()
            .get(hash)
            .unwrap_or(&LedgerMark::Other)
    }

    fn note(&self, hash: &str, signal: WarmSignal, _now_ms: i64) {
        self.notes.lock().unwrap().push((hash.to_string(), signal));
    }
}

/// Porta que só registra as chamadas: prova o "não sonda" sem rede.
#[derive(Default)]
struct FakePort {
    calls: Mutex<Vec<Vec<String>>>,
    silent: Mutex<HashSet<String>>,
    stop_on: Mutex<Option<String>>,
}

impl FakePort {
    fn batches(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
}

impl WarmPort for FakePort {
    fn warm<'a>(&'a self, _api_key: &'a str, hashes: &'a [String]) -> WarmFuture<'a> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(hashes.to_vec());
            let mut report = WarmReport::default();
            let silent = self.silent.lock().unwrap().clone();
            let stop_on = self.stop_on.lock().unwrap().clone();
            for hash in hashes {
                report.attempted += 1;
                if silent.contains(hash) {
                    continue;
                }
                if stop_on.as_deref() == Some(hash.as_str()) {
                    report.stopped = true;
                    break;
                }
                report.signals.push((hash.clone(), WarmSignal::Miss));
            }
            report
        })
    }
}

fn warmer(
    config: WarmConfig,
    key: Arc<dyn WarmKey>,
    port: Arc<dyn WarmPort>,
    ledger: Arc<FakeLedger>,
) -> Arc<Warmer> {
    Warmer::new(config, key, port, ledger)
}

#[tokio::test]
async fn hash_em_cache_nao_reaquece() {
    let ledger = Arc::new(FakeLedger::default());
    ledger.hit(HASH_READY);
    let port = Arc::new(FakePort::default());
    let warm = warmer(
        WarmConfig::fixture(10, 100, 300),
        FakeKey::some("k"),
        port.clone(),
        ledger.clone(),
    );
    let added = warm.enqueue(&payload(&[HASH_READY, HASH_OTHER]));
    assert_eq!(added, 1, "só o hash fora do ledger entra");
    assert_eq!(warm.drain().await, 1);
    assert_eq!(port.batches(), vec![vec![HASH_OTHER.to_string()]]);
    assert_eq!(warm.counters().skipped, 1);
}

#[tokio::test]
async fn lote_grande_respeita_o_corte_do_efeito() {
    let port = Arc::new(FakePort::default());
    let warm = warmer(
        WarmConfig::fixture(10, 100, 300),
        FakeKey::some("k"),
        port,
        Arc::new(FakeLedger::default()),
    );
    let hashes: Vec<String> = (0..25).map(|n| format!("{n:040x}")).collect();
    let refs: Vec<&str> = hashes.iter().map(String::as_str).collect();
    assert_eq!(warm.enqueue(&payload(&refs)), 10);
    assert_eq!(warm.pending(), 10);
}

#[tokio::test]
async fn lote_grande_respeita_o_teto_da_fila() {
    let port = Arc::new(FakePort::default());
    let warm = warmer(
        WarmConfig::fixture(10, 4, 300),
        FakeKey::some("k"),
        port,
        Arc::new(FakeLedger::default()),
    );
    let hashes: Vec<String> = (0..25).map(|n| format!("{n:040x}")).collect();
    let refs: Vec<&str> = hashes.iter().map(String::as_str).collect();
    assert_eq!(warm.enqueue(&payload(&refs)), 4);
    assert_eq!(warm.pending(), 4);
    assert_eq!(warm.counters().dropped_full, 6);
}

#[tokio::test]
async fn dedupe_entre_dois_efeitos_iguais() {
    let port = Arc::new(FakePort::default());
    let warm = warmer(
        WarmConfig::fixture(10, 100, 300),
        FakeKey::some("k"),
        port,
        Arc::new(FakeLedger::default()),
    );
    let body = payload(&[HASH_READY, HASH_OTHER]);
    assert_eq!(warm.enqueue(&body), 2);
    assert_eq!(warm.enqueue(&body), 0);
    assert_eq!(warm.pending(), 2);
}

#[tokio::test]
async fn sem_chave_no_cofre_zero_chamadas() {
    let port = Arc::new(FakePort::default());
    let key = FakeKey::none();
    let warm = warmer(
        WarmConfig::fixture(10, 100, 300),
        key.clone(),
        port.clone(),
        Arc::new(FakeLedger::default()),
    );
    warm.enqueue(&payload(&[HASH_READY, HASH_OTHER]));
    assert_eq!(warm.drain().await, 0);
    assert!(port.batches().is_empty(), "nem uma sonda sem credencial");
    assert_eq!(warm.counters().dropped_no_key, 2);
    assert_eq!(warm.pending(), 0, "o lote é descartado, não fica em laço");
}

#[tokio::test]
async fn erro_de_um_hash_nao_cancela_o_resto() {
    let ledger = Arc::new(FakeLedger::default());
    let port = Arc::new(FakePort::default());
    port.silent.lock().unwrap().insert(HASH_ERR.to_string());
    let warm = warmer(
        WarmConfig::fixture(1, 100, 300),
        FakeKey::some("k"),
        port.clone(),
        ledger.clone(),
    );
    warm.enqueue(&payload(&[HASH_ERR, HASH_READY, HASH_OTHER]));
    assert_eq!(warm.drain().await, 3);
    let notados: Vec<String> = ledger.noted().into_iter().map(|(hash, _)| hash).collect();
    assert_eq!(
        notados,
        vec![HASH_READY.to_string(), HASH_OTHER.to_string()]
    );
    assert_eq!(port.batches().len(), 3);
}

#[tokio::test]
async fn teto_por_hora_para_o_lote_e_devolve_o_resto() {
    let port = Arc::new(FakePort::default());
    let warm = warmer(
        WarmConfig::fixture(10, 100, 2),
        FakeKey::some("k"),
        port.clone(),
        Arc::new(FakeLedger::default()),
    );
    let hashes = [HASH_READY, HASH_DOWN, HASH_ERR, HASH_OTHER];
    warm.enqueue(&payload(&hashes));
    assert_eq!(warm.drain().await, 2);
    assert_eq!(warm.pending(), 2);
    assert_eq!(port.batches().len(), 1);
}

#[tokio::test]
async fn cooldown_devolve_o_que_nao_foi_sondado() {
    let port = Arc::new(FakePort::default());
    port.stop_on.lock().unwrap().replace(HASH_READY.to_string());
    let warm = warmer(
        WarmConfig::fixture(10, 100, 300),
        FakeKey::some("k"),
        port,
        Arc::new(FakeLedger::default()),
    );
    warm.enqueue(&payload(&[HASH_READY, HASH_OTHER]));
    warm.drain().await;
    assert_eq!(warm.pending(), 1, "o hash não sondado volta para a frente");
}

#[tokio::test]
async fn offer_consome_so_o_kind_dono() {
    let port = Arc::new(FakePort::default());
    let warm = warmer(
        WarmConfig::fixture(10, 100, 300),
        FakeKey::some("k"),
        port,
        Arc::new(FakeLedger::default()),
    );
    warm.offer(RD_WARMER, &payload(&[HASH_READY]), Some("realdebrid:conta"));
    assert_eq!(warm.pending(), 1);
    warm.offer(
        "dub_audit",
        &payload(&[HASH_OTHER]),
        Some("realdebrid:conta"),
    );
    assert_eq!(warm.pending(), 1);
}

// ---------------------------------------------------------------------------
// HTTP falso: exercita `GateWarm` (addMagnet + poll + `/torrents` + delete).
// ---------------------------------------------------------------------------

#[derive(Default)]
struct FakeRd {
    deletes: AtomicUsize,
}

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

fn magnet_hash(body: &str) -> String {
    let found = [HASH_READY, HASH_DOWN]
        .into_iter()
        .find(|h| body.contains(h));
    found.map(str::to_string).unwrap_or_default()
}

async fn add_magnet(body: String) -> Response {
    match magnet_hash(&body).as_str() {
        HASH_READY => Json(json!({ "id": "101" })).into_response(),
        HASH_DOWN => Json(json!({ "id": "202" })).into_response(),
        _ => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "boom" })),
        )
            .into_response(),
    }
}

async fn torrent_info(Path(id): Path<String>) -> Json<Value> {
    let status = if id == "101" {
        "downloaded"
    } else {
        "downloading"
    };
    Json(json!({ "id": id, "status": status, "files": [] }))
}

async fn list_torrents() -> Json<Value> {
    Json(json!([
        { "id": 101, "hash": HASH_READY, "status": "downloaded" },
        { "id": 202, "hash": HASH_DOWN, "status": "downloading" },
    ]))
}

async fn remove_torrent(State(state): State<Arc<FakeRd>>) -> axum::http::StatusCode {
    state.deletes.fetch_add(1, Ordering::SeqCst);
    axum::http::StatusCode::NO_CONTENT
}

fn app(state: Arc<FakeRd>) -> Router {
    Router::new()
        .route("/torrents/addMagnet", post(add_magnet))
        .route("/torrents/info/{id}", get(torrent_info))
        .route("/torrents/delete/{id}", delete(remove_torrent))
        .route("/torrents", get(list_torrents))
        .with_state(state)
}

// O cadeado guarda `REALDEBRID_API_BASE` (var de processo) através dos `await`.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn sonda_http_classifica_ready_e_isola_erro() {
    use adom_debrid::rd_scheduler::RdSchedulerConfig;
    use adom_debrid::realdebrid::RealDebrid;
    use adom_debrid::HttpClient;
    use std::time::Duration;

    let _guard = env_lock();
    let state = Arc::new(FakeRd::default());
    let shared = state.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app(state)).await;
    });
    std::env::set_var("REALDEBRID_API_BASE", format!("http://{addr}"));
    let rd = Arc::new(RealDebrid::new(HttpClient::new().unwrap()));
    let gate = super::rd::GateWarm::with_gate(
        rd,
        RdSchedulerConfig {
            min_gap_ms: 0.0,
            max_gap_ms: 0.0,
            cooldown_ms: 0.0,
            play_max_wait_ms: 0.0,
            success_threshold: 5,
            enabled: false,
        },
        Duration::from_millis(1),
    );
    let hashes = vec![
        HASH_ERR.to_string(),
        HASH_READY.to_string(),
        HASH_DOWN.to_string(),
    ];
    let report = gate.warm("chave-de-teste", &hashes).await;
    std::env::remove_var("REALDEBRID_API_BASE");
    server.abort();

    assert!(!report.stopped, "erro de um hash não é cooldown");
    assert!(report
        .signals
        .contains(&(HASH_READY.to_string(), WarmSignal::Hit)));
    assert!(report
        .signals
        .contains(&(HASH_DOWN.to_string(), WarmSignal::Miss)));
    assert!(!report.signals.iter().any(|(hash, _)| hash == HASH_ERR));
    assert_eq!(shared.deletes.load(Ordering::SeqCst), 1, "limpou o magnet");
}
