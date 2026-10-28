//! Intent durável (`rdq:v1:uncertain:`) e peek do ledger `rdc:v2`.
//!
//! O contrato testado é o do Node: grava-antes-do-HTTP, o primeiro gravador
//! ganha, a linha sobrevive ao restart e só prova de marker solta a quarentena.

use std::sync::Arc;

use adom_debrid::realdebrid_autofetch::{uncertain_key, RdWriteKind};
use adom_index::NativeKv;
use serde_json::json;

use super::*;

const ACCOUNT: &str = "conta-sha256-de-teste";
const HASH: &str = "0123456789abcdef0123456789abcdef01234567";

fn memory() -> (Arc<NativeKv>, RdKvStore) {
    let kv = Arc::new(NativeKv::open_memory().expect("kv em memória"));
    (Arc::clone(&kv), RdKvStore::new(kv))
}

fn intent(kind: RdWriteKind, at: i64) -> RdUncertainIntent {
    RdUncertainIntent {
        kind,
        created_at_ms: at,
    }
}

fn marker(kv: &NativeKv, value: serde_json::Value) {
    let now = adom_sources::now_ms();
    kv.put_json(
        &adom_autofetch::v3::marker_key(ADAPTER, ACCOUNT, HASH),
        &value,
        3_600,
        now,
    )
    .expect("marker");
}

#[test]
fn prefixo_bate_com_o_crate() {
    // O prefixo é cópia do texto privado do `adom-debrid`: se um lado mudar, o
    // outro não pode ficar gravando num namespace paralelo de quarentena.
    assert_eq!(
        uncertain_key(ACCOUNT, "ABCDEF"),
        format!("{UNCERTAIN_PREFIX}{ACCOUNT}:abcdef")
    );
}

#[test]
fn intent_entra_uma_vez_so() {
    let (kv, store) = memory();
    let key = uncertain_key(ACCOUNT, HASH);
    assert!(store
        .put_intent_if_absent(&key, &intent(RdWriteKind::Enqueue, 1_000))
        .expect("primeiro intent"));
    assert!(!store
        .put_intent_if_absent(&key, &intent(RdWriteKind::Remove, 2_000))
        .expect("segundo intent"));
    // O carimbo do PRIMEIRO gravador não foi movido.
    let stored = kv
        .get_json(&key, adom_sources::now_ms())
        .expect("leitura")
        .expect("linha viva");
    assert_eq!(stored["kind"], json!("enqueue"));
    assert_eq!(stored["created_at_ms"], json!(1_000));
    assert!(store.has_intent(&key).expect("intent vivo"));
}

#[test]
fn clear_intent_solta_a_quarentena() {
    let (_kv, store) = memory();
    let key = uncertain_key(ACCOUNT, HASH);
    store
        .put_intent_if_absent(&key, &intent(RdWriteKind::Enqueue, 1_000))
        .expect("intent");
    store.clear_intent(&key).expect("limpeza");
    assert!(!store.has_intent(&key).expect("sem intent"));
    // Limpar duas vezes não é erro (recusa definitiva pode repetir).
    store.clear_intent(&key).expect("limpeza idempotente");
}

#[test]
fn intent_sobrevive_ao_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("cache.db");
    let key = uncertain_key(ACCOUNT, HASH);
    {
        let store = RdKvStore::new(Arc::new(NativeKv::open(&path).expect("cache.db")));
        assert!(store
            .put_intent_if_absent(&key, &intent(RdWriteKind::Enqueue, 1_000))
            .expect("intent durável"));
    }
    // Processo novo: a linha continua lá e o reenvio segue barrado.
    let store = RdKvStore::new(Arc::new(NativeKv::open(&path).expect("reopen")));
    assert!(store.has_intent(&key).expect("intent após restart"));
}

#[test]
fn marker_com_id_resolve_o_intent_e_prova_posse() {
    let (kv, store) = memory();
    let key = uncertain_key(ACCOUNT, HASH);
    store
        .put_intent_if_absent(&key, &intent(RdWriteKind::Enqueue, 1_000))
        .expect("intent");

    // Marker legado (`1`): aceite sem id NÃO prova posse nem resolve o intent.
    marker(&kv, json!(1));
    assert!(store.has_intent(&key).expect("intent ainda aberto"));
    assert!(!store.owns_transfer(ACCOUNT, HASH, "42").expect("posse"));

    // Marker com id: o aceite está provado e o hash sai da quarentena.
    marker(&kv, json!({ "id": "42" }));
    assert!(!store.has_intent(&key).expect("intent resolvido"));
    assert!(store.owns_transfer(ACCOUNT, HASH, "42").expect("posse"));
    assert!(!store.owns_transfer(ACCOUNT, HASH, "43").expect("outro id"));
    // Escopo vazio nunca é prova.
    assert!(!store.owns_transfer("", HASH, "42").expect("escopo vazio"));
}

#[test]
fn ledger_peek_traduz_hit_miss_e_ausente() {
    let kv = Arc::new(NativeKv::open_memory().expect("kv em memória"));
    let now = adom_sources::now_ms();
    let miss = "fedcba9876543210fedcba9876543210fedcba98";
    let absent = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    kv.put_json(
        &adom_core::ledger_key(HASH),
        &json!({ "s": "hit", "at": now, "n": 0 }),
        600,
        now,
    )
    .expect("hit");
    kv.put_json(
        &adom_core::ledger_key(miss),
        &json!({ "s": "miss", "at": now, "n": 1 }),
        600,
        now,
    )
    .expect("miss");

    let peek = ledger_peek(Arc::clone(&kv), true).expect("ledger ligado");
    assert_eq!(peek(HASH), Some(true));
    assert_eq!(peek(miss), Some(false));
    assert_eq!(peek(absent), None);
    // Kill-switch desligado = sem peek (o `check` responde `known:false`).
    assert!(ledger_peek(kv, false).is_none());
}
