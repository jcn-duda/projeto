//! Testes do aquecimento do RD: régua do Node, teto, dedupe, chave do cofre e
//! um HTTP falso que exercita a sonda real (`GateWarm` + `RealDebridAutofetch`).

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::tail_effects::NativeEffectSink;
use serde_json::{json, Value};

use super::*;

const HASH_READY: &str = "1111111111111111111111111111111111111111";
const HASH_DOWN: &str = "2222222222222222222222222222222222222222";
const HASH_ERR: &str = "3333333333333333333333333333333333333333";
const HASH_OTHER: &str = "4444444444444444444444444444444444444444";
const RD_SCOPE_A: &str = "realdebrid:conta-a";
const RD_SCOPE_B: &str = "realdebrid:conta-b";

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
    scopes: Mutex<Vec<String>>,
}

impl FakeKey {
    fn some(key: &str) -> Arc<Self> {
        Arc::new(Self {
            key: Some(key.to_string()),
            calls: AtomicUsize::new(0),
            scopes: Mutex::new(Vec::new()),
        })
    }

    fn none() -> Arc<Self> {
        Arc::new(Self {
            key: None,
            calls: AtomicUsize::new(0),
            scopes: Mutex::new(Vec::new()),
        })
    }
}

impl WarmKey for FakeKey {
    fn rd_key(&self, scope: &str, _now_ms: i64) -> Option<String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.scopes.lock().unwrap().push(scope.to_string());
        self.key.as_ref().map(|key| format!("{key}:{scope}"))
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
    credentials: Mutex<Vec<String>>,
    silent: Mutex<HashSet<String>>,
    stop_on: Mutex<Option<String>>,
}

impl FakePort {
    fn batches(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }
}

impl WarmPort for FakePort {
    fn warm<'a>(&'a self, api_key: &'a str, hashes: &'a [String]) -> WarmFuture<'a> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(hashes.to_vec());
            self.credentials.lock().unwrap().push(api_key.to_string());
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
    let added = warm.enqueue(&payload(&[HASH_READY, HASH_OTHER]), RD_SCOPE_A);
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
    assert_eq!(warm.enqueue(&payload(&refs), RD_SCOPE_A), 10);
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
    assert_eq!(warm.enqueue(&payload(&refs), RD_SCOPE_A), 4);
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
    assert_eq!(warm.enqueue(&body, RD_SCOPE_A), 2);
    assert_eq!(warm.enqueue(&body, RD_SCOPE_A), 0);
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
    warm.enqueue(&payload(&[HASH_READY, HASH_OTHER]), RD_SCOPE_A);
    assert_eq!(warm.drain().await, 0);
    assert!(port.batches().is_empty(), "nem uma sonda sem credencial");
    assert_eq!(warm.counters().dropped_no_key, 0);
    assert_eq!(warm.counters().probes, 0, "sem chave não consome orçamento");
    assert_eq!(
        warm.pending(),
        2,
        "a fila mantém a conta e espera a chave voltar"
    );
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
    warm.enqueue(&payload(&[HASH_ERR, HASH_READY, HASH_OTHER]), RD_SCOPE_A);
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
    warm.enqueue(&payload(&hashes), RD_SCOPE_A);
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
    warm.enqueue(&payload(&[HASH_READY, HASH_OTHER]), RD_SCOPE_A);
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
    assert!(warm.offer(RD_WARMER, &payload(&[HASH_READY]), Some(RD_SCOPE_A)));
    assert_eq!(warm.pending(), 1);
    assert!(!warm.offer(
        RD_WARMER,
        &payload(&[HASH_OTHER]),
        Some("alldebrid:conta-b"),
    ));
    assert!(!warm.offer(RD_WARMER, &json!({}), Some(RD_SCOPE_A)));
    assert!(!warm.offer("dub_audit", &payload(&[HASH_OTHER]), Some(RD_SCOPE_A),));
    assert_eq!(warm.pending(), 1);
}

#[tokio::test]
async fn fila_mantem_escopos_e_nunca_mistura_contas_no_mesmo_lote() {
    let port = Arc::new(FakePort::default());
    let key = FakeKey::some("credencial-do-cofre");
    let warm = warmer(
        WarmConfig::fixture(10, 100, 300),
        key.clone(),
        port.clone(),
        Arc::new(FakeLedger::default()),
    );

    assert_eq!(warm.enqueue(&payload(&[HASH_READY]), RD_SCOPE_A), 1);
    assert_eq!(warm.enqueue(&payload(&[HASH_OTHER]), RD_SCOPE_B), 1);
    assert_eq!(warm.drain().await, 2);
    assert_eq!(
        port.batches(),
        vec![vec![HASH_READY.to_string()], vec![HASH_OTHER.to_string()]]
    );
    assert_eq!(
        *key.scopes.lock().unwrap(),
        vec![RD_SCOPE_A.to_string(), RD_SCOPE_B.to_string()]
    );
    assert_eq!(
        *port.credentials.lock().unwrap(),
        vec![
            format!("credencial-do-cofre:{RD_SCOPE_A}"),
            format!("credencial-do-cofre:{RD_SCOPE_B}")
        ]
    );
}

#[path = "rd_warmer_http_tests.rs"]
mod http_tests;
