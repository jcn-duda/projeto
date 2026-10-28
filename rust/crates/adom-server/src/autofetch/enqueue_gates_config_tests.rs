//! Testes do par default/clamp dos SEIS campos do painel que o P4 trouxe para
//! o [`LivePolicy`] (a/b/c por campo): (a) default do TS, (b) valor explícito
//! (com o `Math.trunc` do overlay) e (c) inválido → default / negativo → piso.
//!
//! Réguas de referência: `src/config/debrid.ts:195,285`,
//! `src/config/debrid-autofetch-seeds.ts:19,28,29,34` e os clamps do overlay em
//! `src/utils/autofetch-live.ts:101-139`.
//!
//! Separado de `enqueue_gates_tests.rs` pela catraca de linhas. Todo teste pega
//! o `test_lock`: eles escrevem no `.env` do processo.

use adom_index::NativeKv;
use serde_json::{json, Value};

use super::LivePolicy;

const NOW: i64 = 1_800_000_000_000;
const BR_ENV: &str = "DEBRID_AUTO_FETCH_BR";
const PT_FIRST_ENV: &str = "DEBRID_AUTO_FETCH_SEEDS_PT_FIRST";
const MIN_SEEDERS_ENV: &str = "DEBRID_AUTO_FETCH_MIN_SEEDERS";

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

/// Mede o `LivePolicy` com o boletim do painel dado (`None` = sem overlay), de
/// modo que cada asserção isole uma entrada.
fn load(kv: &NativeKv, overlay: Option<Value>) -> LivePolicy {
    match overlay {
        Some(value) => kv.put_json("cfg:v1:autofetch", &value, 600, NOW).unwrap(),
        None => {
            let _ = kv.forget("cfg:v1:autofetch");
        }
    }
    LivePolicy::load(kv, "alldebrid", NOW).unwrap()
}

/// `autoFetchBr` (`src/config/debrid.ts:195`): default LIGADO e, no painel, a
/// régua é `Boolean(value)` (`utils/autofetch-live.ts:102`).
#[test]
fn auto_fetch_br_segue_o_truthiness_do_painel() {
    let _guard = crate::autofetch::build::test_lock();
    let kv = kv();
    std::env::remove_var(BR_ENV);
    assert!(load(&kv, None).br_enabled, "(a) default ligado");
    assert!(
        load(&kv, Some(json!({ "autoFetchBr": true }))).br_enabled,
        "(b) explícito ligado"
    );
    assert!(
        !load(&kv, Some(json!({ "autoFetchBr": false }))).br_enabled,
        "(b) explícito desligado"
    );
    // (c) `Boolean(value)`: falso para 0, "" e null; verdadeiro para objeto.
    assert!(!load(&kv, Some(json!({ "autoFetchBr": 0 }))).br_enabled);
    assert!(!load(&kv, Some(json!({ "autoFetchBr": "" }))).br_enabled);
    assert!(!load(&kv, Some(json!({ "autoFetchBr": null }))).br_enabled);
    assert!(load(&kv, Some(json!({ "autoFetchBr": {} }))).br_enabled);
}

/// `autoFetchSeedsPtFirst` (`debrid-autofetch-seeds.ts:34`): default LIGADO,
/// mesma régua de truthiness do painel.
#[test]
fn auto_fetch_seeds_pt_first_e_ligado_por_default() {
    let _guard = crate::autofetch::build::test_lock();
    let kv = kv();
    std::env::remove_var(PT_FIRST_ENV);
    assert!(load(&kv, None).seeds_pt_first, "(a) default ligado");
    assert!(
        !load(&kv, Some(json!({ "autoFetchSeedsPtFirst": false }))).seeds_pt_first,
        "(b) explícito desligado"
    );
    assert!(
        load(&kv, Some(json!({ "autoFetchSeedsPtFirst": true }))).seeds_pt_first,
        "(b) explícito ligado"
    );
    assert!(!load(&kv, Some(json!({ "autoFetchSeedsPtFirst": "" }))).seeds_pt_first);
    assert!(!load(&kv, Some(json!({ "autoFetchSeedsPtFirst": 0 }))).seeds_pt_first);
}

/// `autoFetchMinSeeders` (`debrid-autofetch-seeds.ts:19`): default `3`,
/// `Math.max(0, Math.trunc(n))`, e no `.env` o mesmo caminho.
#[test]
fn auto_fetch_min_seeders_usa_default_tres_com_piso_zero() {
    let _guard = crate::autofetch::build::test_lock();
    let kv = kv();
    std::env::remove_var(MIN_SEEDERS_ENV);
    assert_eq!(load(&kv, None).min_seeders, 3, "(a) default 3");
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchMinSeeders": 7 }))).min_seeders,
        7,
        "(b) valor explícito"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchMinSeeders": 6.9 }))).min_seeders,
        6,
        "(b) Math.trunc do overlay"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchMinSeeders": -2 }))).min_seeders,
        0,
        "(c) negativo → piso 0"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchMinSeeders": "muitos" }))).min_seeders,
        3,
        "(c) inválido → default"
    );

    std::env::set_var(MIN_SEEDERS_ENV, "9");
    assert_eq!(load(&kv, None).min_seeders, 9, "(b) pelo .env");
    std::env::set_var(MIN_SEEDERS_ENV, "-9");
    assert_eq!(load(&kv, None).min_seeders, 0, "(c) piso 0 no .env");
    std::env::set_var(MIN_SEEDERS_ENV, "nove");
    assert_eq!(load(&kv, None).min_seeders, 3, "(c) inválido no .env");
    std::env::remove_var(MIN_SEEDERS_ENV);
}

/// `autoFetchRareThreshold` (`debrid-autofetch-seeds.ts:28`): default `6`,
/// `Math.min(20, Math.max(0, Math.trunc(n)))`. `0` DESLIGA o regime raro no TS
/// (`autofetch-seeds-pool.ts:103`), por isso o piso é `0` e não `1`.
#[test]
fn auto_fetch_rare_threshold_usa_default_seis_com_clamp_vinte() {
    let _guard = crate::autofetch::build::test_lock();
    let kv = kv();
    assert_eq!(load(&kv, None).rare_threshold, 6, "(a) default 6");
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareThreshold": 12 }))).rare_threshold,
        12,
        "(b) valor explícito"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareThreshold": 5.9 }))).rare_threshold,
        5,
        "(b) Math.trunc do overlay"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareThreshold": 99 }))).rare_threshold,
        20,
        "(b) clamp superior 20"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareThreshold": -3 }))).rare_threshold,
        0,
        "(c) negativo → piso 0 (desliga o raro)"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareThreshold": "seis" }))).rare_threshold,
        6,
        "(c) inválido → default"
    );
}

/// `autoFetchRareMaxSeeders` (`debrid-autofetch-seeds.ts:29`): default `10`,
/// `Math.max(1, Math.trunc(n))` — raro exige o MELHOR candidato abaixo disso.
#[test]
fn auto_fetch_rare_max_seeders_usa_default_dez_com_piso_um() {
    let _guard = crate::autofetch::build::test_lock();
    let kv = kv();
    assert_eq!(load(&kv, None).rare_max_seeders, 10, "(a) default 10");
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareMaxSeeders": 25 }))).rare_max_seeders,
        25,
        "(b) valor explícito"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareMaxSeeders": 7.8 }))).rare_max_seeders,
        7,
        "(b) Math.trunc do overlay"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareMaxSeeders": 0 }))).rare_max_seeders,
        1,
        "(c) zero → piso 1"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareMaxSeeders": -4 }))).rare_max_seeders,
        1,
        "(c) negativo → piso 1"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchRareMaxSeeders": "dez" }))).rare_max_seeders,
        10,
        "(c) inválido → default"
    );
}

/// `autoFetchPauseRefreshMs` (`src/config/debrid.ts:285`): default `900_000`
/// (15 min), `Math.max(0, n)` na config e no overlay. `0` desliga o memo da
/// sonda de conta (P5).
#[test]
fn auto_fetch_pause_refresh_usa_default_quinze_minutos_com_piso_zero() {
    let _guard = crate::autofetch::build::test_lock();
    let kv = kv();
    assert_eq!(
        load(&kv, None).pause_refresh_ms,
        900_000,
        "(a) default 15 min"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchPauseRefreshMs": 1_000 }))).pause_refresh_ms,
        1_000,
        "(b) valor explícito"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchPauseRefreshMs": 1_500.9 }))).pause_refresh_ms,
        1_500,
        "(b) Math.trunc do overlay"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchPauseRefreshMs": -1 }))).pause_refresh_ms,
        0,
        "(c) negativo → piso 0 (desliga o memo)"
    );
    assert_eq!(
        load(&kv, Some(json!({ "autoFetchPauseRefreshMs": "quinze" }))).pause_refresh_ms,
        900_000,
        "(c) inválido → default"
    );
}
