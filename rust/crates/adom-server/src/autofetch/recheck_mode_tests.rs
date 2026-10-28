//! Relógio do lote: qual INTERVALO vale em cada modo.
//!
//! O Node arma o lote normal com `autoFetchRecheckMs` (2 min) e o lote já em
//! settle com `autoFetchSettleMs` (15 min). Trocar um pelo outro passaria a
//! bater no debrid 7,5× mais vezes sem nenhum teste de status reclamar — a
//! diferença só aparece no RELÓGIO, e é isso que este arquivo prende.

use adom_sources::now_ms;

use super::super::Policy;
use super::{due_at, Lot};

const SEARCH: &str = "tt1234567:1:2";

fn lot() -> Lot {
    Lot {
        search_key: SEARCH.to_string(),
        adapter_id: "alldebrid".to_string(),
        account: "conta-de-teste".to_string(),
        info_hashes: vec![format!("{:040x}", 1)],
        created_at: now_ms(),
        ..Lot::default()
    }
}

/// Cada ESCRITA do lote usa o TTL do próprio lote, então o intervalo não pode
/// ser negativo: `attempts` é a contagem de passagens, não o relógio.
#[test]
fn due_at_usa_o_intervalo_do_modo() {
    let policy = Policy::fixture();
    assert!(policy.settle_interval_ms != policy.recheck_interval_ms);
    let mut lot = lot();
    lot.attempts = 1;
    lot.is_settle = false;
    assert_eq!(
        due_at(&lot, policy),
        lot.created_at + policy.recheck_interval_ms
    );
    lot.is_settle = true;
    assert_eq!(
        due_at(&lot, policy),
        lot.created_at + policy.settle_interval_ms
    );
}

/// Zero passagens ainda espera UM intervalo: sem isso o laço reprocessaria no
/// mesmo ciclo do enfileiramento.
#[test]
fn due_at_sem_passagem_espera_o_primeiro_intervalo() {
    let policy = Policy::fixture();
    let mut lot = lot();
    lot.attempts = 0;
    assert_eq!(
        due_at(&lot, policy),
        lot.created_at + policy.recheck_interval_ms
    );
}

/// O intervalo vem da POLÍTICA, não de uma const: mudar o knob muda o relógio.
#[test]
fn due_at_respeita_o_knob_do_settle() {
    let mut policy = Policy::fixture();
    policy.settle_interval_ms = 60_000;
    let mut lot = lot();
    lot.attempts = 3;
    lot.is_settle = true;
    assert_eq!(due_at(&lot, policy), lot.created_at + 3 * 60_000);
}
