//! Testes da parte de I/O da cobertura BR: operador (env), varredura sobre um
//! `cache.db` temporário, laço desligado por env e a rota `GET /br-coverage`.
#![allow(clippy::await_holding_lock)] // o env_lock atravessa o await de propósito (ver magnet_bank_admin)

use adom_core::{account_scope, ledger_key, prefix};
use adom_index::{idx_prefix, DavailStore, MagnetStateStore, NativeKv};
use axum::http::StatusCode;
use serde_json::{json, Value};

use super::{spawn_from_env, Operator, Readers};
use crate::br_coverage::{apply, Sample, State, STATE};
use crate::magnet_bank_admin::read_tests::{env_lock, get_admin, EnvVar};

const SURFACE: &str = "token-br-coverage";
const KEY: &str = "chave-de-teste-operador";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccc";
const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddd";

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
fn operador_so_com_realdebrid_chave_e_env_operator_account() {
    let _lock = env_lock();
    let _service = EnvVar::set("DEBRID_SERVICE", "realdebrid");
    let _key = EnvVar::set("DEBRID_API_KEY", KEY);
    let _allow = EnvVar::set("DEBRID_ALLOW_ENV_KEY", "false");
    let _op = EnvVar::set("DEBRID_OPERATOR_ENV_ACCOUNT", "true");
    let op = super::operator_from_env().expect("conta do operador");
    assert_eq!(op.scope, account_scope(&json!(KEY)));
    assert_ne!(op.scope, KEY);
    {
        let _svc = EnvVar::set("DEBRID_SERVICE", "alldebrid");
        assert!(super::operator_from_env().is_none());
    }
    {
        let _op = EnvVar::set("DEBRID_OPERATOR_ENV_ACCOUNT", "");
        assert!(super::operator_from_env().is_none());
    }
    {
        let _key = EnvVar::set("DEBRID_API_KEY", "   ");
        assert!(super::operator_from_env().is_none());
    }
    // ALLOW_ENV_KEY vazio/true liga envOperatorAccount mesmo sem OPERATOR.
    let _allow = EnvVar::set("DEBRID_ALLOW_ENV_KEY", "");
    let _op = EnvVar::set("DEBRID_OPERATOR_ENV_ACCOUNT", "");
    assert!(super::operator_from_env().is_some());
}

/// Grava uma linha `cache` no `cache.db` de teste pelo KV nativo.
fn put(kv: &NativeKv, key: &str, value: Value, now: i64) {
    kv.put_json(key, &value, 3_600, now).expect("gravar linha");
}

#[test]
fn varredura_no_banco_real_conta_ledger_davail_alive_e_autofetch() {
    let _lock = env_lock();
    let _top = EnvVar::set("F3_BR_TOP_PER_TYPE", "100");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let now = adom_sources::now_ms();
    let kv = NativeKv::open(&path).unwrap();
    put(
        &kv,
        &format!("{}cohort", prefix("seed")),
        json!({"at": now, "movies": ["tt1", "tt2", "tt3", "tt4"], "series": ["tt5", "tt6"]}),
        now,
    );
    let idx = |imdb: &str, releases: Value| {
        put(
            &kv,
            &format!("{}{imdb}", idx_prefix()),
            json!({"at": now, "partial": false, "releases": releases}),
            now,
        );
    };
    idx(
        "tt1",
        json!([{"hash": HASH_A, "isBr": true, "dubbed": true}]),
    );
    idx(
        "tt2",
        json!([{"hash": HASH_B, "isBr": true, "dubbed": true}]),
    );
    idx(
        "tt4",
        json!([{"hash": HASH_C, "isBr": true, "dubbed": true}]),
    );
    idx(
        "tt5",
        json!([{"hash": HASH_D, "isBr": true, "dubbed": true, "lied": true}]),
    );
    idx(
        "tt6",
        json!([{"hash": HASH_D, "isBr": true, "dubbed": true, "source": "autofetch"}]),
    );
    // Ledger: A hit, B miss. (C e D sem entrada.)
    put(
        &kv,
        &ledger_key(HASH_A),
        json!({"s": "hit", "at": now, "n": 0}),
        now,
    );
    put(
        &kv,
        &ledger_key(HASH_B),
        json!({"s": "miss", "at": now, "n": 0}),
        now,
    );

    let op = Operator {
        key: KEY.to_string(),
        scope: account_scope(&json!(KEY)),
    };
    let davail = DavailStore::open(&path).unwrap();
    davail
        .put_many(
            "realdebrid",
            KEY,
            &[(HASH_C.to_string(), true, now + 3_600_000)],
            now,
        )
        .unwrap();
    let mag = MagnetStateStore::open(&path).unwrap();

    // Sem conta do operador: só o ledger decide (C fica unknown).
    let sem_conta = Readers::open(&path, None, true).unwrap();
    let s = sem_conta.sample(now).unwrap().expect("coorte");
    assert_eq!(s.works_cached, 1);
    assert_eq!(s.works_known_miss, 1);
    assert_eq!(s.works_unknown, 1);
    assert_eq!(s.indexed_works, 5);
    assert_eq!(s.works_with_br, 3);
    assert_eq!(s.series.indexed, 2);
    assert_eq!(s.series.with_br, 0);

    // Com a conta: davail positivo em C e alive em B viram cached.
    mag.mark_alive("realdebrid", KEY, &[HASH_B.to_string()], 3_600, now)
        .unwrap();
    let com_conta = Readers::open(&path, Some(op), true).unwrap();
    let s = com_conta.sample(now).unwrap().expect("coorte");
    assert_eq!(s.works_cached, 3);
    assert_eq!(s.works_known_miss, 0);
    assert_eq!(s.works_unknown, 0);
    assert_eq!(s.releases_cached, 3);
    assert_eq!(s.movie.cached, 3);
    assert_eq!(s.target_works, 6);
}

#[test]
fn varredura_sem_coorte_no_banco_devolve_none() {
    let _lock = env_lock();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let readers = Readers::open(&path, None, true).unwrap();
    assert!(readers.sample(adom_sources::now_ms()).unwrap().is_none());
}

#[test]
fn ledger_desligado_nao_le_nada() {
    let _lock = env_lock();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let now = adom_sources::now_ms();
    let kv = NativeKv::open(&path).unwrap();
    put(
        &kv,
        &ledger_key(HASH_A),
        json!({"s": "hit", "at": now, "n": 0}),
        now,
    );
    put(
        &kv,
        &format!("{}cohort", prefix("seed")),
        json!({"at": now, "movies": ["tt1"]}),
        now,
    );
    put(
        &kv,
        &format!("{}tt1", idx_prefix()),
        json!({"at": now, "partial": false, "releases": [{"hash": HASH_A, "isBr": true, "dubbed": true}]}),
        now,
    );
    let off = Readers::open(&path, None, false).unwrap();
    let s = off.sample(now).unwrap().expect("coorte");
    assert_eq!(s.works_cached, 0);
    assert_eq!(s.works_unknown, 1);
}

#[tokio::test]
async fn desligado_por_env_nao_sobe_laco() {
    let _lock = env_lock();
    let _off = EnvVar::set("F3_BR_ENABLED", "false");
    let _on = EnvVar::set("F3_ENABLED", "true");
    *STATE.lock().unwrap() = State::default();
    spawn_from_env();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let state = STATE.lock().unwrap();
    assert!(state.latest.is_none());
    assert_eq!(state.samples, 0);
}

#[tokio::test]
async fn rota_sem_token_responde_401() {
    let _lock = env_lock();
    let (status, _) = get_admin(SURFACE, None, None, "/br-coverage").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = get_admin(SURFACE, None, Some("errado"), "/br-coverage").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rota_200_com_json_exato_sem_latest() {
    let _lock = env_lock();
    let _on = EnvVar::set("F3_ENABLED", "true");
    let _br = EnvVar::set("F3_BR_ENABLED", "true");
    *STATE.lock().unwrap() = State::default();
    let (status, value) = get_admin(SURFACE, None, Some(SURFACE), "/br-coverage").await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(
        value,
        json!({
            "enabled": true,
            "baselineAt": 0,
            "samples": 0,
            "latest": null,
            "popularCoverage": null,
            "brWarmRate": null,
            "discoveryRate": null,
            "counters": { "sample": 0 },
            "_origem": {
                "popularCoverage": "naomedido",
                "brWarmRate": "naomedido",
                "discoveryRate": "naomedido",
            },
        })
    );
}

#[tokio::test]
async fn rota_com_latest_mede_e_desligado_aparece_no_enabled() {
    let _lock = env_lock();
    let _on = EnvVar::set("F3_ENABLED", "true");
    let _br = EnvVar::set("F3_BR_ENABLED", "true");
    {
        let mut state = STATE.lock().unwrap();
        *state = State::default();
        apply(&mut state, Some(sample_with(4, 2, 1)));
    }
    let (status, value) = get_admin(SURFACE, None, Some(SURFACE), "/br-coverage").await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["enabled"], json!(true));
    assert_eq!(value["samples"], json!(1));
    assert_eq!(value["latest"]["targetWorks"], json!(4));
    assert_eq!(value["latest"]["worksCached"], json!(1));
    assert_eq!(value["popularCoverage"], json!(0.25));
    assert_eq!(value["brWarmRate"], json!(0.5));
    assert_eq!(value["discoveryRate"], json!(0.5));
    assert!(value.get("_origem").is_none(), "{value}");

    let _off = EnvVar::set("F3_BR_ENABLED", "false");
    let (_, value) = get_admin(SURFACE, None, Some(SURFACE), "/br-coverage").await;
    assert_eq!(value["enabled"], json!(false));
    *STATE.lock().unwrap() = State::default();
}
