//! Testes da régua pura da cobertura BR da coorte: ledger, candidatas, agregação,
//! coorte, env e JSON do estado. Os testes de banco e de rota estão em
//! `br_coverage_io_tests.rs`.

use std::collections::HashMap;

use adom_index::IndexedRelease;
use serde_json::{json, Value};

use super::{
    apply, build_sample, is_br_release, ledger_of, parse_cohort, release_status, sample_ms,
    status_json, top_per_type, Cohort, Ledger, ReleaseStatus, Sample, State,
};
use crate::magnet_bank_admin::read_tests::{env_lock, EnvVar};

const KEY: &str = "chave-de-teste-operador";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccc";
const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddd";

fn rel(hash: &str, is_br: bool, dubbed: bool, lied: bool, source: Option<&str>) -> IndexedRelease {
    serde_json::from_value(json!({
        "hash": hash,
        "isBr": is_br,
        "dubbed": dubbed,
        "lied": lied,
        "source": source,
    }))
    .expect("release de teste")
}

fn br(hash: &str) -> IndexedRelease {
    rel(hash, true, true, false, None)
}

fn cohort(movies: &[&str], series: &[&str]) -> Cohort {
    Cohort {
        at: 1_000,
        movies: movies.iter().map(|id| id.to_string()).collect(),
        series: series.iter().map(|id| id.to_string()).collect(),
    }
}

#[test]
fn bloqueado_vence_alive_e_davail_positivo() {
    assert_eq!(
        release_status(Ledger::Blocked, Some(true), true),
        ReleaseStatus::Miss
    );
}

#[test]
fn hit_vence_miss_em_qualquer_fonte() {
    assert_eq!(
        release_status(Ledger::Hit, Some(false), false),
        ReleaseStatus::Hit
    );
    assert_eq!(
        release_status(Ledger::Unknown, Some(false), true),
        ReleaseStatus::Hit
    );
    assert_eq!(release_status(Ledger::Miss, None, true), ReleaseStatus::Hit);
}

#[test]
fn miss_sem_positivo_e_unknown_sem_evidencia() {
    assert_eq!(
        release_status(Ledger::Miss, Some(false), false),
        ReleaseStatus::Miss
    );
    assert_eq!(
        release_status(Ledger::Unknown, Some(false), false),
        ReleaseStatus::Miss
    );
    assert_eq!(
        release_status(Ledger::Unknown, None, false),
        ReleaseStatus::Unknown
    );
}

#[test]
fn lie_e_bad_nao_viram_estado_do_ledger() {
    assert_eq!(ledger_of(Some("lie")), Ledger::Unknown);
    assert_eq!(ledger_of(Some("bad")), Ledger::Unknown);
    assert_eq!(ledger_of(None), Ledger::Unknown);
    assert_eq!(ledger_of(Some("hit")), Ledger::Hit);
    assert_eq!(ledger_of(Some("blocked")), Ledger::Blocked);
}

#[test]
fn autofetch_e_lied_ficam_fora_da_candidata_br() {
    assert!(is_br_release(&br(HASH_A)));
    assert!(!is_br_release(&rel(HASH_A, true, true, true, None)));
    assert!(!is_br_release(&rel(
        HASH_A,
        true,
        true,
        false,
        Some("autofetch")
    )));
    assert!(!is_br_release(&rel(HASH_A, false, true, false, None)));
    assert!(!is_br_release(&rel(HASH_A, true, false, false, None)));
}

#[test]
fn obra_sem_indice_nao_conta_como_indexada() {
    let mut snap = HashMap::new();
    snap.insert("tt2".to_string(), Vec::new());
    let s = build_sample(&cohort(&["tt1", "tt2"], &[]), &snap, 5, |_| {
        ReleaseStatus::Hit
    });
    assert_eq!(s.indexed_works, 0);
    assert_eq!(s.works_with_br, 0);
    assert_eq!(s.movie.indexed, 0);
    assert_eq!(s.movie.target, 2);
    assert_eq!(s.target_works, 2);
}

#[test]
fn obra_sem_br_fica_indexada_mas_fora_do_com_br() {
    let mut snap = HashMap::new();
    snap.insert(
        "tt1".to_string(),
        vec![rel(HASH_A, false, false, false, None)],
    );
    let s = build_sample(&cohort(&["tt1"], &[]), &snap, 5, |_| ReleaseStatus::Hit);
    assert_eq!(s.indexed_works, 1);
    assert_eq!(s.movie.indexed, 1);
    assert_eq!(s.works_with_br, 0);
    assert_eq!(s.releases_with_br, 0);
    assert_eq!(s.works_cached, 0);
}

#[test]
fn agregacao_por_obra_e_por_release() {
    let mut snap = HashMap::new();
    // tt1: dois candidatos, um hit e um unknown → cached (qualquer hit vence).
    snap.insert("tt1".to_string(), vec![br(HASH_A), br(HASH_B)]);
    // tt2: só miss → knownMiss.
    snap.insert("tt2".to_string(), vec![br(HASH_C)]);
    // tt3: miss + unknown → unknown (não é "todas miss").
    snap.insert("tt3".to_string(), vec![br(HASH_C), br(HASH_D)]);
    // S1: a série só tem release lied → indexada, sem BR.
    snap.insert("tt9".to_string(), vec![rel(HASH_A, true, true, true, None)]);
    let status = |r: &IndexedRelease| match r.hash.as_str() {
        HASH_A => ReleaseStatus::Hit,
        HASH_B => ReleaseStatus::Unknown,
        HASH_C => ReleaseStatus::Miss,
        _ => ReleaseStatus::Unknown,
    };
    let s = build_sample(&cohort(&["tt1", "tt2", "tt3"], &["tt9"]), &snap, 77, status);
    assert_eq!(s.at, 77);
    assert_eq!(s.cohort_at, Some(1_000));
    assert_eq!(s.target_works, 4);
    assert_eq!(s.indexed_works, 4);
    assert_eq!(s.works_with_br, 3);
    assert_eq!(s.releases_with_br, 5);
    assert_eq!(s.releases_cached, 1);
    assert_eq!(s.works_cached, 1);
    assert_eq!(s.works_known_miss, 1);
    assert_eq!(s.works_unknown, 1);
    assert_eq!(s.movie.target, 3);
    assert_eq!(s.movie.with_br, 3);
    assert_eq!(s.series.target, 1);
    assert_eq!(s.series.indexed, 1);
    assert_eq!(s.series.with_br, 0);
    assert_eq!(s.series.unknown, 0);
}

#[test]
fn coorte_sanitiza_ids_duplicados_e_teto() {
    let raw = json!({
        "at": 1.5e12,
        "movies": ["tt1", "tt1", "xx", "tt2", 7, "tt3x", "tt10", "tt"],
        "series": ["tt99"],
    });
    let c = parse_cohort(&raw, 100).expect("coorte válida");
    assert_eq!(c.at, 1_500_000_000_000);
    assert_eq!(c.movies, vec!["tt1", "tt2", "tt10"]);
    assert_eq!(c.series, vec!["tt99"]);
    let teto = parse_cohort(&raw, 1).expect("coorte válida");
    assert_eq!(teto.movies, vec!["tt1"]);
    assert_eq!(teto.series, vec!["tt99"]);
}

#[test]
fn coorte_sem_at_numerico_ou_vazia_e_none() {
    assert!(parse_cohort(&json!({"movies": ["tt1"]}), 100).is_none());
    assert!(parse_cohort(&json!({"at": "123", "movies": ["tt1"]}), 100).is_none());
    assert!(parse_cohort(&json!({"at": 5, "movies": [], "series": ["x"]}), 100).is_none());
    assert!(parse_cohort(&json!({"at": 5, "movies": "tt1"}), 100).is_none());
}

#[test]
fn top_e_intervalo_seguem_a_regua_do_ts() {
    assert_eq!(top_per_type(None), 100);
    assert_eq!(top_per_type(Some("0")), 1);
    assert_eq!(top_per_type(Some("500")), 100);
    assert_eq!(top_per_type(Some("12.9")), 12);
    assert_eq!(top_per_type(Some("abc")), 100);
    assert_eq!(top_per_type(Some("")), 1);
    assert_eq!(sample_ms(None), 300_000);
    assert_eq!(sample_ms(Some("1000")), 30_000);
    assert_eq!(sample_ms(Some("45000")), 45_000);
}

#[test]
fn sem_coorte_zera_estado_e_origem_aparece() {
    let mut state = State::default();
    apply(&mut state, Some(sample_with(4, 2, 3)));
    apply(&mut state, Some(sample_with(4, 2, 3)));
    assert_eq!(state.samples, 2);
    assert_eq!(state.counter_sample, 2);
    apply(&mut state, None);
    assert!(state.latest.is_none());
    assert_eq!(state.baseline_at, 0);
    assert_eq!(state.samples, 0);
    // O contador é histórico: não volta com a coorte expirada.
    assert_eq!(state.counter_sample, 2);
    let body = status_json(&state, true);
    assert_eq!(body["latest"], Value::Null);
    assert_eq!(body["popularCoverage"], Value::Null);
    assert_eq!(body["_origem"]["popularCoverage"], json!("naomedido"));
    assert_eq!(body["_origem"]["brWarmRate"], json!("naomedido"));
    assert_eq!(body["_origem"]["discoveryRate"], json!("naomedido"));
}

fn sample_with(target: u64, with_br: u64, cached: u64) -> Sample {
    Sample {
        at: 10,
        target_works: target,
        works_with_br: with_br,
        works_cached: cached,
        ..Sample::default()
    }
}

#[test]
fn razoes_sao_null_sem_denominador_e_medidas_com_ele() {
    let mut state = State::default();
    apply(&mut state, Some(sample_with(4, 0, 0)));
    let body = status_json(&state, true);
    assert_eq!(body["popularCoverage"], json!(0.0));
    assert_eq!(body["brWarmRate"], Value::Null);
    assert_eq!(body["discoveryRate"], json!(0.0));
    assert!(body.get("_origem").is_none());

    let mut vazio = State::default();
    apply(&mut vazio, Some(sample_with(0, 0, 0)));
    let body = status_json(&vazio, false);
    assert_eq!(body["popularCoverage"], Value::Null);
    assert_eq!(body["discoveryRate"], Value::Null);
}

#[test]
fn enabled_exige_as_duas_flags_true() {
    let _lock = env_lock();
    let _a = EnvVar::set("F3_ENABLED", "");
    let _b = EnvVar::set("F3_BR_ENABLED", "");
    assert!(super::enabled_now());
    let _c = EnvVar::set("F3_ENABLED", "false");
    assert!(!super::enabled_now());
    let _d = EnvVar::set("F3_ENABLED", "true");
    let _e = EnvVar::set("F3_BR_ENABLED", "no");
    assert!(!super::enabled_now());
}

#[test]
fn saida_nao_expoe_hash_nem_chave() {
    let mut state = State::default();
    apply(&mut state, Some(sample_with(1, 1, 1)));
    let texto = status_json(&state, true).to_string();
    assert!(!texto.contains(HASH_A));
    assert!(!texto.contains(KEY));
}
