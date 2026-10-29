//! Testes do wiring NATIVO dos fatos: `owned_at` passa OBRIGATORIAMENTE pelo
//! `DurablePeek` — o kill-switch da posse (`ALLDEBRID_SUBMITTED_TTL_MS <= 0`)
//! desliga a prova NA ORIGEM, mesmo com registro `adsub` vivo no banco. Ler o
//! KV por presença (como antes) manteria o reconcile condenando com a régua
//! do Node já caída.
//!
//! Filho de `al_sweeps_native`.

use std::path::{Path, PathBuf};

use serde_json::json;

use adom_debrid::alldebrid_cleanup::{adhold_key, adsub_key, DurablePeek, SUBMITTED_TTL_ENV};
use adom_index::NativeKv;

use super::super::FactSource;
use super::facts_for_test;

const SCOPE: &str = "sweep-native-test-scope";

/// Relógio REAL: o `DurablePeek` compara o `expires_at` do registro com o
/// agora do processo — um `NOW` fixo do teste venceria o registro.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// Trava de env: `SUBMITTED_TTL_ENV` é de processo e os testes rodam em
/// paralelo (mesmo padrão de `rd_warmer_http_tests`). À prova de poison: um
/// pânico do teste anterior não pode derrubar o próximo.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "al-sweeps-native-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Fatos com `adsub` VIVO no banco e `kv: None` de propósito: se `owned_at`
/// lesse o KV direto (sem o `DurablePeek`), não haveria prova nenhuma — o
/// `Some` do teste default é a prova do wiring.
fn owned_facts(dir: &Path) -> (super::NativeFacts, i64) {
    let db = dir.join("cache.db");
    let kv = NativeKv::open(&db).expect("cache.db de teste abre");
    let now = now_ms();
    kv.put_json(&adsub_key(SCOPE, "abc"), &json!({ "at": now }), 3_600, now)
        .expect("adsub gravado");
    (facts_for_test(SCOPE, None, DurablePeek::new(db)), now)
}

#[test]
fn owned_at_com_a_regua_default_le_o_adsub_vivo() {
    let _env = env_lock();
    let dir = temp_dir("default");
    let (facts, now) = owned_facts(&dir);
    assert_eq!(
        facts.owned_at("abc"),
        Some(now),
        "registro vivo prova posse pela via do DurablePeek"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn owned_at_com_kill_switch_vira_none_mesmo_com_registro_vivo() {
    let _env = env_lock();
    let dir = temp_dir("killed");
    std::env::set_var(SUBMITTED_TTL_ENV, "0");
    let (facts, _) = owned_facts(&dir);
    let owned = facts.owned_at("abc");
    std::env::remove_var(SUBMITTED_TTL_ENV);
    assert_eq!(
        owned, None,
        "TTL 0 desliga a posse NA ORIGEM: registro vivo não é prova"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Hold com prova (`held_checked`) e a legibilidade que o planejador usa:
/// `Some(false)` é ausência PROVADA; `None`/`false` é leitura que falhou —
/// "sem hold" e "sem plano" não podem nascer de banco que não abriu.
#[test]
fn hold_e_legibilidade_duravel_sao_fail_closed() {
    let dir = temp_dir("adhold");
    let db = dir.join("cache.db");
    let kv = NativeKv::open(&db).expect("cache.db de teste abre");
    let now = now_ms();
    kv.put_json(&adhold_key(SCOPE, "abc"), &json!({ "at": now }), 3_600, now)
        .expect("adhold gravado");
    let facts = facts_for_test(SCOPE, None, DurablePeek::new(&db));
    assert_eq!(
        facts.held_checked("abc"),
        Some(true),
        "adhold vivo é hold provado pela via do DurablePeek"
    );
    assert_eq!(
        facts.held_checked("zzz"),
        Some(false),
        "sem registro: ausência PROVADA"
    );
    assert!(facts.durable_readable(), "banco aberto é legível");

    let sem_banco = facts_for_test(SCOPE, None, DurablePeek::new(dir.join("ausente.db")));
    assert_eq!(
        sem_banco.held_checked("abc"),
        None,
        "hold ilegível não é ausência de hold"
    );
    assert!(
        !sem_banco.durable_readable(),
        "banco ausente fecha o planejamento e a guarda viva"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
