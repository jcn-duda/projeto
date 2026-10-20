use std::path::Path;

use adom_search::orchestrator::KnownBroken;
use rusqlite::{params, Connection};
use serde_json::json;

use super::{mag_prefix, mark_key, MagnetDbStore};

const HASH_A: &str = "0123456789abcdef0123456789abcdef01234567";
const HASH_B: &str = "89abcdef0123456789abcdef0123456789abcdef";
const HASH_C: &str = "fedcba9876543210fedcba9876543210fedcba98";
const KEY: &str = "chave-da-conta";

fn seed(path: &Path, rows: &[(String, i64)]) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS cache (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL,
             expires_at INTEGER NOT NULL
         );",
    )
    .unwrap();
    for (key, expires_at) in rows {
        conn.execute(
            "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)",
            params![key, "1", expires_at],
        )
        .unwrap();
    }
}

#[test]
fn chave_de_marca_e_a_mesma_do_node() {
    // `mag:v1:` + campo + adapter + accountScope (sha256 hex) + hash minúsculo.
    let account = adom_core::account_scope(&json!(KEY));
    assert_eq!(mag_prefix(), "mag:v1:");
    assert_eq!(
        mark_key("bad", "alldebrid", KEY, &HASH_A.to_uppercase()),
        format!("mag:v1:bad:alldebrid:{account}:{HASH_A}")
    );
}

#[test]
fn le_bad_e_lie_vivos_da_conta_e_ignora_o_resto() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    seed(
        &path,
        &[
            // vivos desta conta: entram
            (mark_key("bad", "alldebrid", KEY, HASH_A), 10_000),
            (mark_key("lie", "alldebrid", KEY, HASH_B), 10_000),
            // vencido (mesmo campo, outro hash): fora
            (mark_key("bad", "alldebrid", KEY, HASH_C), 500),
            // outro adapter, outra conta, outro campo (alive): fora
            (mark_key("bad", "torbox", KEY, HASH_B), 10_000),
            (mark_key("bad", "alldebrid", "outra-conta", HASH_C), 10_000),
            (mark_key("alive", "alldebrid", KEY, HASH_C), 10_000),
            // chave fora do namespace: ignorada
            ("streams:v21:movie:tt1:x".to_string(), 10_000),
        ],
    );
    let store = MagnetDbStore::open_read_only(&path).unwrap();
    let broken = store
        .broken_hashes_internal("alldebrid", KEY, 1_000)
        .unwrap();
    assert_eq!(
        broken,
        [HASH_A.to_string(), HASH_B.to_string()]
            .into_iter()
            .collect(),
        "só bad/lie vivos desta conta"
    );
    // A outra conta tem o próprio `bad` (hash C) e não herda o desta.
    let other = store
        .broken_hashes_internal("alldebrid", "outra-conta", 1_000)
        .unwrap();
    assert_eq!(other, [HASH_C.to_string()].into_iter().collect());
    // O adapter sem evidência nenhuma lê vazio.
    assert!(store
        .broken_hashes_internal("premiumize", KEY, 1_000)
        .unwrap()
        .is_empty());
}

#[test]
fn marca_vencida_nao_conta() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    seed(&path, &[(mark_key("bad", "realdebrid", KEY, HASH_A), 900)]);
    let store = MagnetDbStore::open_read_only(&path).unwrap();
    assert!(store
        .broken_hashes_internal("realdebrid", KEY, 1_000)
        .unwrap()
        .is_empty());
}

#[test]
fn sem_adapter_ou_chave_nao_le_nada() {
    let store = MagnetDbStore::open_memory().unwrap();
    assert!(store.broken_hashes_internal("", KEY, 0).unwrap().is_empty());
    assert!(store
        .broken_hashes_internal("torbox", "", 0)
        .unwrap()
        .is_empty());
    // O trait nunca propaga erro: o caminho da busca segue sem evidência.
    assert!(KnownBroken::broken_hashes(&store, "torbox", KEY, 0).is_empty());
}

#[test]
fn banco_inexistente_falha_para_o_caller_degradar() {
    let dir = tempfile::tempdir().unwrap();
    assert!(MagnetDbStore::open_read_only(&dir.path().join("nao-existe.db")).is_err());
}
