//! Banco de magnets do warmer: `alive` no hit, `bad` do play não ressuscita e o
//! reparo dos `bad` gravados por recusa legal (ledger `blocked`).

use std::sync::Arc;

use adom_index::{MagnetState, MagnetStateStore};

use crate::rd_warmer::magnet::MagnetDb;
use crate::rd_warmer::{LedgerMark, WarmLedger, WarmMagnet, WarmSignal};

use super::{HASH_OTHER, HASH_READY};

const ADAPTER: &str = "realdebrid";
const API_KEY: &str = "chave-de-teste";
const NOW: i64 = 1_700_000_000_000;

fn setup() -> (Arc<MagnetStateStore>, MagnetDb) {
    let store = Arc::new(MagnetStateStore::open_memory().expect("magnetdb em memória"));
    let db = MagnetDb::memory(Arc::clone(&store));
    (store, db)
}

/// Ledger mínimo do reparo: só o hash informado é `blocked`; o resto é `Other`.
struct BlockedLedger {
    blocked: &'static str,
}

impl WarmLedger for BlockedLedger {
    fn state(&self, hash: &str, _now_ms: i64) -> LedgerMark {
        if hash == self.blocked {
            LedgerMark::Blocked
        } else {
            LedgerMark::Other
        }
    }

    fn note(&self, _hash: &str, _signal: WarmSignal, _now_ms: i64) {}
}

#[test]
fn hit_marca_alive_e_nao_e_bad() {
    let (store, db) = setup();
    db.mark_alive(API_KEY, HASH_READY, NOW);

    assert_eq!(
        store
            .state(ADAPTER, API_KEY, HASH_READY, NOW)
            .expect("leitura do magnetdb"),
        Some(MagnetState::Alive),
        "o hit grava a marca alive do MESMO adapter/conta"
    );
    assert!(!db.is_bad(API_KEY, HASH_READY, NOW));
    assert!(
        !db.is_bad(API_KEY, HASH_OTHER, NOW),
        "hash sem marca não é bad"
    );
}

#[test]
fn bad_do_play_nao_e_ressuscitado_pelo_hit() {
    let (store, db) = setup();
    // É a escrita do play (`mark_bad`) que prova a release quebrada.
    store
        .mark_bad(ADAPTER, API_KEY, HASH_READY, 86_400, NOW)
        .expect("bad do play");
    assert!(db.is_bad(API_KEY, HASH_READY, NOW));

    db.mark_alive(API_KEY, HASH_READY, NOW);
    assert_eq!(
        store
            .state(ADAPTER, API_KEY, HASH_READY, NOW)
            .expect("leitura do magnetdb"),
        Some(MagnetState::Bad),
        "bad vivo vence o alive e o aquecimento não ressuscita"
    );
    assert!(db.is_bad(API_KEY, HASH_READY, NOW));
}

#[test]
fn reparo_apaga_so_o_bad_que_o_ledger_prova_bloqueado() {
    let (store, db) = setup();
    store
        .mark_bad(ADAPTER, API_KEY, HASH_READY, 86_400, NOW)
        .expect("bad de recusa legal");
    store
        .mark_bad(ADAPTER, API_KEY, HASH_OTHER, 86_400, NOW)
        .expect("bad de magnet quebrado");

    let ledger = BlockedLedger {
        blocked: HASH_READY,
    };
    assert_eq!(
        db.scan_blocked_bads(&ledger, NOW),
        1,
        "só o hash que o ledger prova blocked é recuperado"
    );
    assert_eq!(
        store
            .state(ADAPTER, API_KEY, HASH_READY, NOW)
            .expect("leitura do magnetdb"),
        None,
        "o bad da recusa legal sumiu"
    );
    assert_eq!(
        store
            .state(ADAPTER, API_KEY, HASH_OTHER, NOW)
            .expect("leitura do magnetdb"),
        Some(MagnetState::Bad),
        "bad sem prova de blocked fica"
    );
    // Idempotente: a segunda passada não tem o que apagar.
    assert_eq!(db.scan_blocked_bads(&ledger, NOW), 0);
}
