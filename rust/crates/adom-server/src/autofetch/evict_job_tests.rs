//! Evicção fiada: os quatro testes que DOEM (sem inventário, com hold, com
//! `adrm`, com prova completa) mais os fatos ausentes do Node.
//!
//! Nenhum teste toca rede nem env do processo: as réguas entram como
//! [`EvictConfig`] e o debrid como [`StubIo`] (fila roteirizada de `evict`).

use std::collections::VecDeque;
use std::sync::Mutex;

use adom_autofetch::v3::{
    AccountEvidence, AutofetchDebrid, CacheEvidence, DebridFuture, EnqueueEvidence, QueueCandidate,
    TorrentEvidence,
};

use super::*;

const NOW: i64 = 1_700_000_000_000;
const MIN_AGE: i64 = 1_800_000;
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta";
const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const READY: &str = "ready0001";
const FALLBACK: &str = "fall00001";
const OTHER: &str = "fall00002";

fn kv() -> NativeKv {
    NativeKv::open_memory().expect("kv em memória")
}

fn entry(hash: &str, pool: &str, dubbed: bool, accepted_at: i64) -> serde_json::Value {
    json!({
        "hash": hash,
        "pool": pool,
        "acceptedAt": accepted_at as f64,
        "br": pool == "br",
        "dubbed": dubbed,
        "id": format!("t-{hash}"),
    })
}

fn put_record(kv: &NativeKv, entries: Vec<serde_json::Value>) {
    kv.put_json(
        &format!("{}{DIGEST}", obra_prefix()),
        &json!({ "entries": entries }),
        21_600,
        NOW,
    )
    .expect("registro F2");
}

/// Registro com o READY (`br`+`dubbed`, 2 h) e UM fallback (`any`, 1 h).
fn record(kv: &NativeKv) {
    put_record(
        kv,
        vec![
            entry(READY, "br", true, NOW - 7_200_000),
            entry(FALLBACK, "any", false, NOW - 3_600_000),
        ],
    );
}

fn marker(kv: &NativeKv, hash: &str, obra: Option<&str>) {
    let mut value = json!({ "id": format!("t-{hash}"), "acceptedAt": NOW });
    if let Some(obra) = obra {
        value["pool"] = json!("any");
        value["obra"] = json!(obra);
    }
    kv.put_json(&marker_key(ADAPTER, ACCOUNT, hash), &value, 21_600, NOW)
        .expect("marker");
}

fn adsub(kv: &NativeKv, hash: &str) {
    kv.put_json(
        &adsub_key(ACCOUNT, hash),
        &json!({ "at": NOW - 3_600_000 }),
        86_400,
        NOW,
    )
    .expect("adsub");
}

fn config() -> EvictConfig {
    EvictConfig {
        gates: EvictGates {
            enabled: true,
            max_per_run: 25,
            min_age_ms: MIN_AGE,
            occupancy: None,
        },
        marks: MarkGates {
            enabled: true,
            ttl_seconds: 259_200,
        },
    }
}

fn work(ready: &[String]) -> ReadyWork<'_> {
    ReadyWork {
        adapter_id: ADAPTER,
        account: ACCOUNT,
        ready_hashes: ready,
        br_ready_ttl_seconds: 21_600,
    }
}

/// Cenário mínimo para o fallback ser ELEGÍVEL: registro, markers da obra,
/// posse durável e o READY no lote.
fn completo(kv: &NativeKv) -> Vec<String> {
    record(kv);
    marker(kv, READY, Some(DIGEST));
    marker(kv, FALLBACK, Some(DIGEST));
    adsub(kv, FALLBACK);
    vec![READY.to_string()]
}

/// Duplo do debrid: `evict` roteirizado + as chamadas registradas.
struct StubIo {
    results: Mutex<VecDeque<Result<Vec<String>, String>>>,
    calls: Mutex<Vec<Vec<String>>>,
}

impl StubIo {
    fn new(results: Vec<Result<Vec<String>, String>>) -> Self {
        Self {
            results: Mutex::new(results.into()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().expect("trava").clone()
    }
}

impl AutofetchDebrid for StubIo {
    type Error = String;

    fn enqueue<'a>(
        &'a self,
        _candidate: &'a QueueCandidate,
    ) -> DebridFuture<'a, EnqueueEvidence, String> {
        Box::pin(async { Err("evict não enfileira".to_string()) })
    }

    fn status<'a>(
        &'a self,
        _hashes: &'a [String],
        _transfer_ids: &'a std::collections::BTreeMap<String, String>,
    ) -> DebridFuture<'a, std::collections::BTreeMap<String, TorrentEvidence>, String> {
        Box::pin(async { Ok(std::collections::BTreeMap::new()) })
    }

    fn check<'a>(&'a self, _hashes: &'a [String]) -> DebridFuture<'a, CacheEvidence, String> {
        Box::pin(async {
            Ok(CacheEvidence {
                known: false,
                cached: Vec::new(),
            })
        })
    }

    fn remove<'a>(&'a self, _transfer_id: &'a str) -> DebridFuture<'a, bool, String> {
        Box::pin(async { Err("evict por hash: sem âncora".to_string()) })
    }

    fn evict<'a>(&'a self, hashes: &'a [String]) -> DebridFuture<'a, Vec<String>, String> {
        Box::pin(async move {
            self.calls.lock().expect("trava").push(hashes.to_vec());
            self.results
                .lock()
                .expect("trava")
                .pop_front()
                .unwrap_or_else(|| Ok(Vec::new()))
        })
    }

    fn account(&self) -> DebridFuture<'_, AccountEvidence, String> {
        Box::pin(async {
            Ok(AccountEvidence {
                used: None,
                max: None,
            })
        })
    }
}

/// (a) Sem inventário legível a porta recusa: zero removidos, zero `adrm`.
#[tokio::test]
async fn sem_inventario_nao_apaga_e_nao_marca() {
    let kv = kv();
    let ready = completo(&kv);
    let io = StubIo::new(vec![Err(
        "other: evict sem inventário legível (cache.db)".to_string()
    )]);

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 1, "o plano autorizou o fallback");
    assert_eq!(report.removed, 0, "sem prova não sai remoção");
    assert_eq!(report.marked, 0, "sem remoção não há o que marcar");
    assert!(report
        .errors
        .iter()
        .any(|err| err.contains("sem inventário")));
    assert!(
        kv.get_json(&adrm_key(ACCOUNT, FALLBACK), NOW)
            .unwrap()
            .is_none(),
        "adrm só nasce do que a conta confirmou removido"
    );
}

/// (b) Hold vivo (`adhold:v1`) não apaga — e a porta nem é chamada.
#[tokio::test]
async fn com_hold_nao_apaga() {
    let kv = kv();
    let ready = completo(&kv);
    kv.put_json(
        &adhold_key(ACCOUNT, FALLBACK),
        &json!({ "at": NOW }),
        600,
        NOW,
    )
    .expect("hold");
    let io = StubIo::new(Vec::new());

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 0);
    assert_eq!(report.skips.get("evict-held"), Some(&1));
    assert!(
        io.calls().is_empty(),
        "hash barrado não vira chamada de rede"
    );
}

/// (c) `adrm` NEGA a posse: hash apagado de propósito não conta como nosso.
#[tokio::test]
async fn com_adrm_nao_conta_posse() {
    let kv = kv();
    let ready = completo(&kv);
    kv.put_json(
        &adrm_key(ACCOUNT, FALLBACK),
        &json!({ "at": NOW }),
        21_600,
        NOW,
    )
    .expect("adrm");
    let io = StubIo::new(Vec::new());

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 0);
    assert_eq!(report.skips.get("evict-no-ownership"), Some(&1));
    assert!(io.calls().is_empty());
}

/// (d) Prova completa: apaga o fallback, NUNCA o `br`, e grava o `adrm`.
#[tokio::test]
async fn prova_completa_apaga_e_marca() {
    let kv = kv();
    let ready = completo(&kv);
    let io = StubIo::new(vec![Ok(vec![FALLBACK.to_string()])]);

    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 1);
    assert_eq!(report.removed, 1);
    assert_eq!(report.marked, 1);
    assert_eq!(io.calls(), vec![vec![FALLBACK.to_string()]]);
    assert!(
        kv.get_json(&adrm_key(ACCOUNT, FALLBACK), NOW)
            .unwrap()
            .is_some(),
        "anti-reenchimento do hash removido"
    );
    assert_eq!(report.skips.get("evict-pool-br"), Some(&1), "o br fica");
    assert!(
        kv.get_json(&br_ready_key(DIGEST), NOW).unwrap().is_some(),
        "evidência de BR ready da obra (paridade com `noteBrReady`)"
    );
}

/// Tira (`present:false`) ou repõe (`true`) UM dos fatos do Node na cena.
fn fact(kv: &NativeKv, name: &str, present: bool) {
    match (name, present) {
        ("ready-marker", true) => marker(kv, READY, Some(DIGEST)),
        ("ready-marker", false) => marker(kv, READY, None),
        ("obra-marker", true) => marker(kv, FALLBACK, Some(DIGEST)),
        ("obra-marker", false) => marker(kv, FALLBACK, None),
        ("registro-f2", true) => record(kv),
        ("registro-f2", false) => forget_key(kv, &format!("{}{DIGEST}", obra_prefix())),
        (_, true) => adsub(kv, FALLBACK),
        (_, false) => forget_key(kv, &adsub_key(ACCOUNT, FALLBACK)),
    }
}

fn forget_key(kv: &NativeKv, key: &str) {
    kv.forget(key).expect("forget no KV");
}

/// (e) Um FATO do Node por vez: sem ele NADA é apagado e o motivo é o daquele
/// fato; reposto, o gate abre. Os três juntos já são o caso (d).
#[tokio::test]
async fn cada_fato_e_necessario_e_suficiente() {
    for (fato, motivo) in [
        ("ready-marker", "evict-no-marker"),
        ("obra-marker", "evict-other-work"),
        ("registro-f2", "evict-no-record"),
        ("posse-adsub", "evict-no-ownership"),
    ] {
        let kv = kv();
        let ready = completo(&kv);
        fact(&kv, fato, false);
        let io = StubIo::new(Vec::new());
        let report = run(&kv, &io, &work(&ready), &config(), NOW).await;
        assert_eq!((report.requested, report.removed), (0, 0), "{fato} ausente");
        assert_eq!(report.skips.get(motivo), Some(&1), "{fato}: motivo");
        assert!(report.errors.is_empty(), "{fato}: ausência não é erro");
        assert!(io.calls().is_empty(), "{fato}: nenhuma ida à conta");

        fact(&kv, fato, true);
        let io = StubIo::new(vec![Ok(vec![FALLBACK.to_string()])]);
        let report = run(&kv, &io, &work(&ready), &config(), NOW).await;
        assert_eq!(report.requested, 1, "{fato} reposto: o gate abre");
    }
}

/// (f) Guarda ILEGÍVEL não é guarda vazia: valor fora do contrato não vira
/// permissão — o registro cai no MESMO motivo da ausência.
#[tokio::test]
async fn registro_com_forma_estranha_nao_autoriza() {
    let kv = kv();
    let ready = completo(&kv);
    let key = format!("{}{DIGEST}", obra_prefix());
    kv.put_json(&key, &json!("quebrado"), 21_600, NOW)
        .expect("lixo");
    let io = StubIo::new(Vec::new());
    let report = run(&kv, &io, &work(&ready), &config(), NOW).await;

    assert_eq!(report.requested, 0);
    assert_eq!(report.skips.get("evict-no-record"), Some(&1));
    assert!(io.calls().is_empty());
}

/// (g) Kill-switch OFF: zero leitura útil, zero rede.
#[tokio::test]
async fn kill_switch_desligado_nao_toca_a_conta() {
    let kv = kv();
    let ready = completo(&kv);
    let io = StubIo::new(Vec::new());
    let mut off = config();
    off.gates = EvictGates::off();

    let report = run(&kv, &io, &work(&ready), &off, NOW).await;

    assert_eq!(report.requested, 0);
    assert_eq!(report.removed, 0);
    assert_eq!(report.marked, 0);
    assert!(report.errors.is_empty());
    assert_eq!(report.skips.get("evict-off"), Some(&1));
    assert!(io.calls().is_empty());
}

/// (h) Teto da RODADA atravessa obras: o excedente sai rotulado, não some.
#[tokio::test]
async fn teto_da_rodada_limita_o_plano() {
    let kv = kv();
    let ready = completo(&kv);
    kv.put_json(
        &format!("{}{DIGEST}", obra_prefix()),
        &json!({ "entries": [
            entry(READY, "br", true, NOW - 7_200_000),
            entry(FALLBACK, "any", false, NOW - 3_600_000),
            entry(OTHER, "any", false, NOW - 3_600_000),
        ]}),
        21_600,
        NOW,
    )
    .expect("registro");
    marker(&kv, OTHER, Some(DIGEST));
    adsub(&kv, OTHER);
    let mut curto = config();
    curto.gates.max_per_run = 1;
    let io = StubIo::new(vec![Ok(vec![FALLBACK.to_string()])]);

    let report = run(&kv, &io, &work(&ready), &curto, NOW).await;

    assert_eq!(report.requested, 1);
    assert_eq!(report.skips.get("evict-over-limit"), Some(&1));
    assert_eq!(io.calls().len(), 1);
}
