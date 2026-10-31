//! Testes de `dedup.rs`, portados de `test/catalog.test.ts` (T1/T2/apply) e
//! `test/catalog-work-versions.test.ts` (T3), com as mesmas entradas e saídas.

use std::future::Future;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use super::*;
use crate::rows::{CatalogStore, Row};

pub(crate) const ACCOUNT: &str = "conta-de-teste";
pub(crate) const ADAPTER: &str = "alldebrid";

/// Executor mínimo: os futures de teste nunca ficam pendentes.
pub(crate) fn block_on<F: Future>(fut: F) -> F::Output {
    let mut cx = Context::from_waker(Waker::noop());
    let mut fut = pin!(fut);
    loop {
        if let Poll::Ready(value) = fut.as_mut().poll(&mut cx) {
            return value;
        }
    }
}

pub(crate) fn none(_: &str) -> bool {
    false
}

/// Linha viva ("Ready", não ativa, `ready` ligado).
pub(crate) fn row(id: &str, hash: &str, name: &str, size: i64, uploaded_at: i64) -> Row {
    Row {
        adapter: ADAPTER.into(),
        account: ACCOUNT.into(),
        service_id: id.into(),
        hash: hash.into(),
        filename: name.into(),
        size,
        status: "Ready".into(),
        ready: 1,
        uploaded_at,
        ..Row::default()
    }
}

pub(crate) fn store_with(rows: Vec<Row>) -> CatalogStore {
    let store = CatalogStore::open_memory().unwrap();
    for r in &rows {
        store.put_row(r).unwrap();
    }
    store
}

fn dedup(store: &CatalogStore, protected: &dyn Fn(&str) -> bool) -> DedupPlan {
    plan_dedup(store, ACCOUNT, ADAPTER, protected).unwrap()
}

fn ids(group: &DedupGroup) -> Vec<&str> {
    std::iter::once(group.keep.service_id.as_str())
        .chain(group.kill.iter().map(|k| k.service_id.as_str()))
        .collect()
}

pub(crate) fn get(store: &CatalogStore, id: &str) -> Row {
    store.get_row(ADAPTER, ACCOUNT, id).unwrap().unwrap()
}

// --- planDedup T1 / T2 -------------------------------------------------------

#[test]
fn t1_mesmo_hash_com_dois_ids_vivos() {
    // catalog.test.ts: "planDedup T1: mesmo hash com 2 service_ids vivos".
    let h = "a".repeat(40);
    let store = store_with(vec![
        row("10", &h, "Filme 2024 Dublado 1080p", 0, 1000),
        row("11", &h, "Filme 2024 Dublado 1080p", 0, 2000),
    ]);
    let plan = dedup(&store, &none);
    assert_eq!(plan.t1.len(), 1, "um grupo por hash");
    assert_eq!(
        plan.t1[0].keep.service_id, "10",
        "o upload mais antigo sobrevive"
    );
    assert_eq!(plan.t1[0].kill.len(), 1);
}

#[test]
fn t2_caso_real_tolerancia_de_0_5_por_cento() {
    // catalog.test.ts: "planDedup T2 ... (caso real)": 1.960 bytes de diferença.
    let store = store_with(vec![
        row(
            "713999816",
            &"d".repeat(40),
            "Devoradores.de.Estrelas.2026.Dual.5.1",
            3_357_118_139,
            3000,
        ),
        row(
            "713999501",
            &"e".repeat(40),
            "Devoradores de Estrelas 2026 Dual 5.1",
            3_357_116_179,
            1000,
        ),
    ]);
    let plan = dedup(&store, &none);
    assert!(plan.t1.is_empty(), "hashes diferentes: não é T1");
    assert_eq!(plan.t2.len(), 1);
    assert_eq!(
        plan.t2[0].keep.service_id, "713999501",
        "o mais antigo sobrevive"
    );
    assert_eq!(plan.t2[0].kill[0].service_id, "713999816");
}

#[test]
fn t2_item_que_cruza_a_tolerancia_abre_o_proximo_cluster() {
    // catalog.test.ts: "item que cruza a tolerância abre o próximo cluster".
    let store = store_with(vec![
        row(
            "104",
            &"3c".repeat(20),
            "Devaradores de Estrelas 2026 Dual",
            1_000_000_000,
            1000,
        ),
        row(
            "103",
            &"3b".repeat(20),
            "Devaradores-de-Estrelas-2026-dual",
            1_000_001_000,
            2000,
        ),
        row(
            "102",
            &"3a".repeat(20),
            "Devaradores [de Estrelas] 2026 DUAL",
            2_000_000_000,
            3000,
        ),
        row(
            "101",
            &"30".repeat(20),
            "Devaradores_de_Estrelas_2026_Dual",
            2_000_001_000,
            4000,
        ),
    ]);
    let plan = dedup(&store, &none);
    assert_eq!(plan.t2.len(), 2, "dois clusters");
    let mut members: Vec<&str> = plan.t2.iter().flat_map(ids).collect();
    members.sort_unstable();
    assert_eq!(members, vec!["101", "102", "103", "104"], "nenhum se perde");
    assert!(plan.t2.iter().all(|g| g.kill.len() == 1));
}

#[test]
fn t2_fora_da_tolerancia_e_tamanho_desconhecido_nao_agrupam() {
    // catalog.test.ts: "NÃO agrupa tamanhos fora da tolerância" e "não agrupa tamanho desconhecido".
    let fora = store_with(vec![
        row(
            "1",
            &"1a".repeat(20),
            "Devoradores de Estrelas 2026 Dual 5.1",
            3_357_116_179,
            1000,
        ),
        row(
            "2",
            &"2b".repeat(20),
            "Devoradores.de.Estrelas.2026.Dual.5.1",
            3_692_827_797,
            2000,
        ),
    ]);
    assert!(dedup(&fora, &none).t2.is_empty());
    let zero = store_with(vec![
        row(
            "1",
            &"1a".repeat(20),
            "Devoradores de Estrelas 2026 Dual 5.1",
            0,
            1000,
        ),
        row(
            "2",
            &"2b".repeat(20),
            "Devoradores.de.Estrelas.2026.Dual.5.1",
            0,
            2000,
        ),
    ]);
    assert!(dedup(&zero, &none).t2.is_empty());
}

#[test]
fn t2_sobrevivente_protegido_vence_mesmo_sendo_o_mais_novo() {
    // catalog.test.ts: "sobrevivente do dedup em T2 é o protegido mesmo sendo o mais novo".
    let newer = "f".repeat(40);
    let older = "g".repeat(40);
    let store = store_with(vec![
        row(
            "1",
            &newer,
            "Devoradores de Estrelas 2026 Dual 5.1",
            3_362_762_342,
            10_000,
        ),
        row(
            "2",
            &older,
            "Devoradores.de.Estrelas.2026.Dual.5.1",
            3_362_762_342,
            1000,
        ),
    ]);
    let protect = |hash: &str| hash == newer;
    let plan = dedup(&store, &protect);
    assert_eq!(plan.t2.len(), 1);
    assert_eq!(plan.t2[0].keep.hash, newer);
    assert_eq!(plan.t2[0].kill[0].hash, older);
}

#[test]
fn sobrevivente_protegido_nao_pronto_vence_pelo_find() {
    // Protegido não-pronto nunca fica em primeiro; vence pelo ramo do `find`.
    let held = "2".repeat(40);
    let mut held_row = row("2", &held, "Filme.Dual.2024.mkv", 5000, 9000);
    held_row.ready = 0;
    held_row.status = "Pending".into();
    let store = store_with(vec![
        row("1", &"1".repeat(40), "Filme Dual 2024", 5000, 1000),
        held_row,
    ]);
    let protect = |hash: &str| hash == held;
    let plan = dedup(&store, &protect);
    assert_eq!(plan.t2.len(), 1);
    assert_eq!(plan.t2[0].keep.service_id, "2");
    assert_eq!(plan.t2[0].kill[0].service_id, "1");
}

#[test]
fn nao_protegido_sai_para_o_protegido_ficar() {
    let held = "b".repeat(40);
    let store = store_with(vec![
        row("1", &"a".repeat(40), "Filme Dual 2024", 5000, 1000),
        row("2", &held, "Filme.Dual.2024.mkv", 5000, 2000),
    ]);
    let protect = |hash: &str| hash == held;
    let plan = dedup(&store, &protect);
    assert_eq!(plan.t2[0].keep.service_id, "2");
    assert_eq!(plan.t2[0].kill[0].service_id, "1");
}

#[test]
fn t2_nao_apaga_protegido_de_outro_hash() {
    let (h1, h2) = ("a".repeat(40), "b".repeat(40));
    let store = store_with(vec![
        row("1", &h1, "Filme Dual 2024", 5000, 1000),
        row("2", &h2, "Filme.Dual.2024.mkv", 5000, 2000),
    ]);
    let plan = dedup(&store, &|_: &str| true);
    assert!(
        plan.t2.is_empty(),
        "os dois hashes protegidos ficam na conta"
    );
}

#[test]
fn t1_protegido_duplicado_sai_porque_o_hash_fica() {
    let hash = "a".repeat(40);
    let store = store_with(vec![
        row("1", &hash, "Filme Dual 2024", 5000, 1000),
        row("2", &hash, "Filme Dual 2024", 5000, 2000),
    ]);
    let plan = dedup(&store, &|_: &str| true);
    assert_eq!(plan.t1[0].keep.service_id, "1");
    assert_eq!(plan.t1[0].kill[0].service_id, "2");
}

#[test]
fn kill_ativo_nao_sai_do_plano_e_tombstone_nao_entra() {
    // catalog.test.ts: "kill ativo (download em curso) não sai do plano".
    let h = "a".repeat(40);
    let mut downloading = row("3", &h, "Filme 2024 1080p", 0, 3000);
    downloading.status = "Downloading".into();
    downloading.ready = 0;
    let mut dead = row("4", &h, "Filme 2024 1080p", 0, 4000);
    dead.deleted_at = 5;
    let store = store_with(vec![
        row("1", &h, "Filme 2024 1080p", 0, 1000),
        row("2", &h, "Filme 2024 1080p", 0, 2000),
        downloading,
        dead,
    ]);
    let plan = dedup(&store, &none);
    assert_eq!(plan.t1.len(), 1);
    let killed: Vec<&str> = plan.t1[0]
        .kill
        .iter()
        .map(|k| k.service_id.as_str())
        .collect();
    assert_eq!(killed, vec!["2"], "ativo e tombstone nunca são kill");
}

#[test]
fn filename_normalized_iguala_separadores_e_tira_extensao() {
    assert_eq!(
        filename_normalized("Devoradores.2026.Dual.5.1"),
        "devoradores 2026 dual 5"
    );
    assert_eq!(
        filename_normalized("Devoradores de Estrelas 2026 Dual 5.1"),
        "devoradores de estrelas 2026 dual 5"
    );
    assert_eq!(filename_normalized("Filme_X-y [z].MKV"), "filme x y z");
    // Igual ao TS: "2024" sem outro ponto antes é tirado como extensão.
    assert_eq!(filename_normalized("Filme.Dual.2024"), "filme dual");
    assert_eq!(filename_normalized("  "), "");
    // U+FEFF é espaço no JS; U+0085 não é.
    assert_eq!(filename_normalized("a\u{FEFF}b"), "a b");
    assert_eq!(filename_normalized("a\u{85}b"), "a\u{85}b");
}

#[test]
fn dedup_group_json_usa_os_nomes_do_ts() {
    let h = "a".repeat(40);
    let store = store_with(vec![
        row("10", &h, "Filme 2024", 0, 1000),
        row("11", &h, "Filme 2024", 0, 2000),
    ]);
    let v = serde_json::to_value(&dedup(&store, &none).t1[0]).unwrap();
    assert_eq!(v["key"], h);
    assert_eq!(v["keep"]["serviceId"], "10");
    assert_eq!(v["keep"]["uploadedAt"], 1000);
    assert_eq!(v["keep"]["ready"], true);
    assert_eq!(v["keep"]["active"], false);
    assert_eq!(v["keep"]["protected"], false);
    assert_eq!(v["kill"][0]["serviceId"], "11");
    assert!(
        v["keep"].get("service_id").is_none(),
        "nome snake_case não vaza"
    );
}

#[test]
fn pick_survivor_pronto_depois_protegido_depois_antigo() {
    let r = |id: &str, ready: bool, protected: bool, up: i64| DedupRow {
        service_id: id.into(),
        hash: String::new(),
        filename: String::new(),
        size: 1,
        ready,
        uploaded_at: up,
        status: String::new(),
        active: false,
        protected,
    };
    let rows = [
        r("a", false, false, 1),
        r("b", true, false, 9),
        r("c", true, false, 5),
    ];
    assert_eq!(pick_survivor(&rows).unwrap().service_id, "c");
    let rows = [r("a", true, false, 1), r("b", true, true, 9)];
    assert_eq!(pick_survivor(&rows).unwrap().service_id, "b");
    assert!(pick_survivor(&[]).is_none());
}

// --- planWorkVersions (T3) ---------------------------------------------------
