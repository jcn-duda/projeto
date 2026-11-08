//! Política do usuário no Chupim: `dubbedOnly` tira o pool `seeds`, o teto por
//! qualidade ADIA (nunca descarta) o dublado excedente, o dreno lê o mesmo teto
//! do lote e a sobra da checagem volta à limpeza.

use std::collections::BTreeMap;

use adom_autofetch::v3::{QueueCandidate, QueueV3};
use adom_core::SeedsStopReason;
use adom_index::NativeKv;
use adom_sources::now_ms;
use serde_json::{json, Map, Value};

use super::super::super::enqueue_drain::drain_one;
use super::super::super::fakes::{job, FakeDebrid, SCOPE};
use super::super::super::{recheck, Policy};
use super::super::{run, Holds};
use super::{record, seeds_stop, QualityGate, UserPolicy};

const SEARCH: &str = "streams:v21:movie:tt1234567:x:account:y";
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

fn kv() -> NativeKv {
    let kv = NativeKv::open_memory().unwrap();
    // Config PINADA: os testes de env escrevem no processo em paralelo.
    kv.put_json("cfg:v1:autofetch", &json!({ "autoFetchMax": 3 }), 600, now_ms())
        .unwrap();
    kv
}

/// Item do lote: `(hash, qualidade, dublado BR?)`. Sem dublagem é pool `seeds`.
fn payload(items: &[(&str, &str, bool)], policy: Value) -> Map<String, Value> {
    let items: Vec<Value> = items
        .iter()
        .map(|(hash, quality, br)| {
            json!({
                "infoHash": hash,
                "title": format!("Titulo de Teste {quality}"),
                "name": format!("Titulo de Teste {quality}"),
                "_quality": quality,
                "_seeders": 40,
                "_size": 1_000_000_000u64,
                "_br": br,
                "_dubbed": br
            })
        })
        .collect();
    serde_json::from_value(json!({
        "searchKey": SEARCH,
        "imdbId": "tt1234567",
        "items": items,
        "policy": policy
    }))
    .unwrap()
}

fn caps(quality: &str, cap: i64) -> Value {
    json!({ "dubbedOnly": true, "qualityLimits": { quality: cap } })
}

fn queued(kv: &NativeKv, now: i64) -> Vec<String> {
    QueueV3::new(kv)
        .read_queue(SEARCH, now)
        .unwrap()
        .into_iter()
        .map(|candidate| candidate.info_hash)
        .collect()
}

#[test]
fn politica_le_dubbed_only_e_os_tetos_do_payload() {
    let user = UserPolicy::from_payload(&payload(&[], caps("1080p", 2)));
    assert!(user.dubbed_only);
    assert_eq!(user.quality_caps.get("1080p"), Some(&2));
    // Gateway antigo (sem `policy`): tudo desligado, o comportamento de antes.
    let old = UserPolicy::from_payload(&payload(&[], Value::Null));
    assert_eq!(old, UserPolicy::default());
}

#[test]
fn seeds_para_com_dublado_ou_qualquer_coisa_em_cache() {
    assert_eq!(seeds_stop(true, 1), Some(SeedsStopReason::StopHasBr));
    assert_eq!(seeds_stop(false, 2), Some(SeedsStopReason::StopHasCached));
    assert_eq!(seeds_stop(false, 0), None);
}

/// Aranhaverso (2026-11-08): com `dubbedOnly` o 4K em inglês nem sobe.
#[tokio::test]
async fn dubbed_only_tira_o_pool_seeds_antes_do_hold() {
    let (kv, now, holds) = (kv(), now_ms(), Holds::default());
    let debrid = FakeDebrid::accepting();
    let (one, two) = (hash_of(1), hash_of(2));
    let items = [(one.as_str(), "2160p", false), (two.as_str(), "2160p", false)];
    let report = run(&kv, Policy::fixture(), &holds, false, &debrid, &job(SCOPE, payload(&items, caps("2160p", 2))), now)
        .await
        .unwrap();
    assert_eq!(report.refused, Some("dubbed-only"));
    assert!(debrid.accepted().is_empty());
    assert!(debrid.released.lock().unwrap().is_empty(), "nada foi checado");
    assert!(queued(&kv, now).is_empty());
    assert_eq!(holds.len(), 0);
}

#[tokio::test]
async fn teto_por_qualidade_adia_o_terceiro_dublado_sem_descartar() {
    let (kv, now, holds) = (kv(), now_ms(), Holds::default());
    let debrid = FakeDebrid::accepting();
    let hashes: Vec<String> = (1..=3).map(hash_of).collect();
    let items: Vec<(&str, &str, bool)> = hashes.iter().map(|h| (h.as_str(), "1080p", true)).collect();
    let report = run(&kv, Policy::fixture(), &holds, false, &debrid, &job(SCOPE, payload(&items, caps("1080p", 2))), now)
        .await
        .unwrap();
    assert_eq!(debrid.accepted(), vec![hash_of(1), hash_of(2)]);
    assert_eq!(report.skips.get("quality-cap"), Some(&1));
    // O excedente fica na fila: sobe quando um dos dois morrer.
    assert_eq!(queued(&kv, now), hashes);
    assert_eq!(report.qualities.len(), 2);
    // O que o lote checou e não aceitou volta à limpeza.
    assert_eq!(*debrid.released.lock().unwrap(), vec![hash_of(3)]);
}

/// Lote do recheck com `hashes` em voo na qualidade `quality` e o teto `cap`.
fn lot_in_flight(kv: &NativeKv, hashes: &[String], quality: &str, cap: i64, now: i64) {
    let enqueued: Vec<(String, Option<String>)> = hashes.iter().map(|h| (h.clone(), None)).collect();
    recheck::schedule(kv, Policy::fixture(), SEARCH, (ADAPTER, ACCOUNT), &enqueued, &BTreeMap::new(), now)
        .unwrap();
    let user = UserPolicy::from_payload(&payload(&[], caps(quality, cap)));
    let accepted: BTreeMap<String, String> = hashes.iter().map(|h| (h.clone(), quality.to_string())).collect();
    record(kv, Policy::fixture(), SEARCH, &user, &accepted, now).unwrap();
}

#[tokio::test]
async fn busca_seguinte_conta_o_que_ja_esta_em_voo_e_morto_libera_a_vaga() {
    let (kv, now) = (kv(), now_ms());
    lot_in_flight(&kv, &[hash_of(1), hash_of(2)], "1080p", 2, now);
    let three = hash_of(3);
    let items = [(three.as_str(), "1080p", true)];
    let debrid = FakeDebrid::accepting();
    let job = job(SCOPE, payload(&items, caps("1080p", 2)));
    let report = run(&kv, Policy::fixture(), &Holds::default(), false, &debrid, &job, now).await.unwrap();
    assert!(debrid.accepted().is_empty(), "dois em voo: o terceiro espera");
    assert_eq!(report.skips.get("quality-cap"), Some(&1));

    QueueV3::new(&kv).mark_dead(ADAPTER, ACCOUNT, &hash_of(1), 600, now).unwrap();
    let debrid = FakeDebrid::accepting();
    run(&kv, Policy::fixture(), &Holds::default(), false, &debrid, &job, now).await.unwrap();
    assert_eq!(debrid.accepted(), vec![hash_of(3)], "o morto devolveu a vaga");
}

#[test]
fn faixa_pronta_fica_coberta_para_o_dreno() {
    let (kv, now) = (kv(), now_ms());
    lot_in_flight(&kv, &[hash_of(1)], "720p", 2, now);
    let mut lot = recheck::read(&kv, SEARCH, now).unwrap().unwrap();
    super::note_ready(&mut lot, &hash_of(1));
    recheck::write(&kv, &lot, Policy::fixture(), now).unwrap();
    let gate = QualityGate::load(&kv, None, (ADAPTER, ACCOUNT), SEARCH, now).unwrap();
    assert!(gate.full(Some("br"), Some("720p")), "720p pronto: não dispara outro");
    assert!(!gate.full(Some("br"), Some("1080p")), "sem teto configurado não barra");
    assert!(!gate.full(Some("any"), Some("720p")), "só o pool br tem teto");
}

fn queued_br(kv: &NativeKv, hash: &str, quality: &str, now: i64) {
    let candidate = QueueCandidate {
        info_hash: hash.to_string(),
        quality: Some(quality.to_string()),
        pool: Some("br".to_string()),
        br: Some(true),
        dubbed: Some(true),
        ..QueueCandidate::default()
    };
    QueueV3::new(kv)
        .write_queue(SEARCH, &[candidate], 600, 6, Some((ADAPTER, ACCOUNT)), now)
        .unwrap();
}

#[tokio::test]
async fn dreno_respeita_o_teto_e_poe_o_iniciado_no_recheck() {
    let (kv, now) = (kv(), now_ms());
    lot_in_flight(&kv, &[hash_of(1)], "1080p", 1, now);
    queued_br(&kv, &hash_of(2), "1080p", now);
    let scope = format!("{ADAPTER}:{ACCOUNT}");
    let debrid = FakeDebrid::accepting();
    let holds = Holds::default();
    let report = drain_one(&kv, Policy::fixture(), &holds, false, &debrid, &scope, SEARCH, now)
        .await
        .unwrap();
    assert!(report.started.is_none(), "1080p cheio: o dreno não dispara");
    assert_eq!(queued(&kv, now), vec![hash_of(2)], "o adiado continua na fila");

    QueueV3::new(&kv).mark_dead(ADAPTER, ACCOUNT, &hash_of(1), 600, now).unwrap();
    let report = drain_one(&kv, Policy::fixture(), &holds, false, &debrid, &scope, SEARCH, now)
        .await
        .unwrap();
    assert_eq!(report.started, Some(hash_of(2)));
    let lot = recheck::read(&kv, SEARCH, now).unwrap().unwrap();
    assert!(lot.info_hashes.contains(&hash_of(2)), "drenado entra no recheck");
    assert_eq!(lot.qualities.get(&hash_of(2)).map(String::as_str), Some("1080p"));
}

#[test]
fn boot_solta_so_o_hold_orfao_do_chupim() {
    let (kv, now) = (kv(), now_ms());
    let retention = super::super::retention::hold;
    retention(&kv, ACCOUNT, &hash_of(1), 600, now).unwrap(); // órfão
    retention(&kv, ACCOUNT, &hash_of(2), 600, now).unwrap(); // aceito (marker)
    QueueV3::new(&kv)
        .set_marker(ADAPTER, ACCOUNT, &hash_of(2), &json!(1), 600, now)
        .unwrap();
    let admin = format!("adhold:v1:{ACCOUNT}:{}", hash_of(3)); // API admin: sem marca
    kv.put_json(&admin, &json!({ "at": now }), 600, now).unwrap();

    let released = super::super::retention::release_orphans(&kv, now).unwrap();
    assert_eq!(released, 1);
    let alive = |hash: &str| {
        kv.get_json(&format!("adhold:v1:{ACCOUNT}:{hash}"), now)
            .unwrap()
            .is_some()
    };
    assert!(!alive(&hash_of(1)));
    assert!(alive(&hash_of(2)));
    assert!(alive(&hash_of(3)));
}
