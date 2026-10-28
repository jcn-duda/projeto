//! Prova que o ledger do warmer grava a MESMA chave e forma do Node
//! (`rdc:v2:<hash>` com `{s,at,n}`) e respeita `blocked` como o veredito.

use super::KvLedger;
use crate::rd_warmer::{LedgerMark, WarmLedger, WarmSignal};
use adom_core::ledger_key;

const HASH: &str = "1111111111111111111111111111111111111111";

#[test]
fn miss_e_hit_gravam_a_forma_do_node() {
    let ledger = KvLedger::memory();
    ledger.note(HASH, WarmSignal::Miss, 1_000_000);
    assert_eq!(ledger.state(HASH, 1_000_000), LedgerMark::Other);

    ledger.note(HASH, WarmSignal::Hit, 1_000_000);
    assert_eq!(ledger.state(HASH, 1_000_000), LedgerMark::Hit);

    let kv = ledger.kv.as_deref().expect("kv de teste");
    let stored = kv.get_json(&ledger_key(HASH), 1_000_000).unwrap().unwrap();
    assert_eq!(stored["s"], "hit");
    assert_eq!(stored["n"], 0, "hit zera o contador de tentativas");
}

#[test]
fn blocked_nao_e_sobrescrito_por_hit_nem_por_miss() {
    let ledger = KvLedger::memory();
    ledger.note(HASH, WarmSignal::Blocked, 1_000_000);
    ledger.note(HASH, WarmSignal::Hit, 1_000_000);
    ledger.note(HASH, WarmSignal::Miss, 1_000_000);
    assert_eq!(ledger.state(HASH, 1_000_000), LedgerMark::Blocked);
}
