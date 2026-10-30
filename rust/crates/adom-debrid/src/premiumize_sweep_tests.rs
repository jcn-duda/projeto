use std::collections::HashMap;

use serde_json::{json, Value};

use super::{by_id_from_markers, marker_prefix, memory_key, plan_sweep, SweepPlan};

const H1: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const H2: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const H3: &str = "cccccccccccccccccccccccccccccccccccccccc";
const ACC: &str = "acc";
const OTHER: &str = "other";
const NOW: i64 = 10_000;
const MIN_AGE: i64 = 1_000;
const PARADA: &str = "0 Bytes of 0 Bytes, from 0 peer";

fn btih(hash: &str) -> String {
    format!("magnet:?xt=urn:btih:{hash}")
}

/// Transferência `running` parada, com `src` de magnet real.
fn parada(id: &str, hash: &str) -> Value {
    json!({"id": id, "status": "running", "progress": 0, "message": PARADA, "src": btih(hash)})
}

fn run(
    transfers: &[Value],
    by_id: &HashMap<String, String>,
    memory: &mut HashMap<String, i64>,
    held: &[&str],
    account: &str,
) -> SweepPlan {
    let held: Vec<String> = held.iter().map(|h| h.to_string()).collect();
    plan_sweep(
        transfers,
        by_id,
        |hash| held.iter().any(|h| h == hash),
        memory,
        account,
        NOW,
        MIN_AGE,
    )
}

fn no_ids() -> HashMap<String, String> {
    HashMap::new()
}

#[test]
fn erro_e_alvo_sempre_mesmo_sem_hash() {
    let transfers = [json!({"id": "9", "status": "error", "name": "Qualquer coisa"})];
    let mut memory = HashMap::new();
    let plan = run(&transfers, &no_ids(), &mut memory, &[], ACC);
    assert_eq!(plan.targets, vec![("9".to_string(), None)]);
    assert_eq!(plan.observed, 0);
    assert!(memory.is_empty());
}

#[test]
fn erro_com_hash_leva_o_hash_junto() {
    let transfers = [json!({"id": "9", "status": "error", "src": btih(H1)})];
    let mut memory = HashMap::new();
    let plan = run(&transfers, &no_ids(), &mut memory, &[], ACC);
    assert_eq!(plan.targets, vec![("9".to_string(), Some(H1.to_string()))]);
}

#[test]
fn running_em_movimento_e_pulado() {
    let transfers = [
        json!({"id": "1", "status": "running", "progress": 0.4, "message": PARADA, "src": btih(H1)}),
        json!({"id": "2", "status": "running", "progress": 0, "message": "Downloading 10%", "src": btih(H2)}),
    ];
    let mut memory = HashMap::new();
    let plan = run(&transfers, &no_ids(), &mut memory, &[], ACC);
    assert!(plan.targets.is_empty());
    assert_eq!(plan.observed, 0);
    assert!(memory.is_empty());
}

#[test]
fn queued_e_finished_nunca_entram() {
    let transfers = [
        json!({"id": "1", "status": "queued", "progress": 0, "message": PARADA, "src": btih(H1)}),
        json!({"id": "2", "status": "finished", "src": btih(H2)}),
    ];
    let mut memory = HashMap::new();
    let plan = run(&transfers, &no_ids(), &mut memory, &[], ACC);
    assert!(plan.targets.is_empty());
    assert!(memory.is_empty());
}

#[test]
fn primeira_vista_anota_e_nao_remove() {
    let transfers = [parada("1", H1)];
    let mut memory = HashMap::new();
    let plan = run(&transfers, &no_ids(), &mut memory, &[], ACC);
    assert!(plan.targets.is_empty());
    assert_eq!(plan.observed, 1);
    assert_eq!(memory.get(&memory_key(ACC, H1)), Some(&NOW));
}

#[test]
fn segunda_vista_depois_da_idade_minima_remove() {
    let transfers = [parada("1", H1)];
    let mut memory = HashMap::from([(memory_key(ACC, H1), NOW - MIN_AGE - 1)]);
    let plan = run(&transfers, &no_ids(), &mut memory, &[], ACC);
    assert_eq!(plan.targets, vec![("1".to_string(), Some(H1.to_string()))]);
    assert_eq!(plan.observed, 1);
}

#[test]
fn antes_da_idade_minima_fica() {
    let transfers = [parada("1", H1)];
    let mut memory = HashMap::from([(memory_key(ACC, H1), NOW - MIN_AGE + 1)]);
    let plan = run(&transfers, &no_ids(), &mut memory, &[], ACC);
    assert!(plan.targets.is_empty());
    assert_eq!(plan.observed, 1);
    assert_eq!(memory.get(&memory_key(ACC, H1)), Some(&(NOW - MIN_AGE + 1)));
}

#[test]
fn held_e_pulado_sem_entrar_na_memoria() {
    let transfers = [parada("1", H1)];
    let mut memory = HashMap::new();
    let plan = run(&transfers, &no_ids(), &mut memory, &[H1], ACC);
    assert!(plan.targets.is_empty());
    assert_eq!(plan.observed, 0);
    assert!(memory.is_empty());
}

#[test]
fn parada_sem_hash_e_pulada() {
    let transfers = [
        json!({"id": "1", "status": "running", "progress": 0, "message": PARADA, "name": "Filme Humano"}),
    ];
    let mut memory = HashMap::new();
    let plan = run(&transfers, &no_ids(), &mut memory, &[], ACC);
    assert!(plan.targets.is_empty());
    assert_eq!(plan.observed, 0);
    assert!(memory.is_empty());
}

#[test]
fn by_id_resolve_nome_humano() {
    let transfers = [json!({
        "id": "7", "status": "running", "progress": 0, "message": PARADA,
        "name": "[WWW.BLUDV.TV] Filme [DUBLADO]"
    })];
    let by_id = HashMap::from([("7".to_string(), H2.to_string())]);
    let mut memory = HashMap::from([(memory_key(ACC, H2), NOW - MIN_AGE - 5)]);
    let plan = run(&transfers, &by_id, &mut memory, &[], ACC);
    assert_eq!(plan.targets, vec![("7".to_string(), Some(H2.to_string()))]);
}

#[test]
fn src_vence_o_by_id() {
    let transfers = [parada("7", H1)];
    let by_id = HashMap::from([("7".to_string(), H2.to_string())]);
    let mut memory = HashMap::new();
    let plan = run(&transfers, &by_id, &mut memory, &[], ACC);
    assert_eq!(plan.observed, 1);
    assert!(memory.contains_key(&memory_key(ACC, H1)));
    assert!(!memory.contains_key(&memory_key(ACC, H2)));
}

#[test]
fn poda_so_desta_conta() {
    // H3 de ACC não foi visto agora: some. H3 de OTHER fica intocado.
    let transfers = [parada("1", H1)];
    let mut memory = HashMap::from([
        (memory_key(ACC, H3), NOW - 50),
        (memory_key(OTHER, H3), NOW - 50),
        (memory_key(ACC, H1), NOW - 10),
    ]);
    run(&transfers, &no_ids(), &mut memory, &[], ACC);
    assert!(!memory.contains_key(&memory_key(ACC, H3)));
    assert!(memory.contains_key(&memory_key(OTHER, H3)));
    assert!(memory.contains_key(&memory_key(ACC, H1)));
}

#[test]
fn marker_rows_viram_mapa_por_id() {
    let p = marker_prefix(ACC);
    let rows = vec![
        (format!("{p}{H1}"), r#"{"id":"12"}"#.to_string()),
        (format!("{p}{H2}"), r#"{"id":34}"#.to_string()),
        (format!("{p}{H3}"), "1".to_string()),
        (
            format!("{}{H1}", marker_prefix(OTHER)),
            r#"{"id":"99"}"#.to_string(),
        ),
        (format!("{p}zzz"), r#"{"id":"55"}"#.to_string()),
        (format!("{p}{H1}x"), r#"{"id":"56"}"#.to_string()),
    ];
    let map = by_id_from_markers(&rows, ACC);
    assert_eq!(map.get("12").map(String::as_str), Some(H1));
    assert_eq!(map.get("34").map(String::as_str), Some(H2));
    assert_eq!(map.len(), 2);
}
