//!
//! Testes do claim DURÁVEL (T1-B1): o slot em voo tem que sobreviver ao
//! restart, e obra que derruba o processo não pode virar laço infinito.
//!
//! Cenário-raiz: `take_head` tira a entrada da memória e o drain roda sem o
//! lock; um `enqueue` durante o drain persiste a fila. Sem o claim no mesmo
//! documento, essa escrita apagaria a obra em voo do L2.

use super::*;
use crate::queue::{HarvestQueue, HarvestQueueConfig};
use crate::reason::entry_identity;
use crate::store::{HarvestStore, DEFAULT_ENTRY_TTL_SECONDS};
use crate::types::HarvestRequest;

const NOW: i64 = 1_700_000_000_000;

fn fila() -> HarvestQueue {
    HarvestQueue::with_clock(HarvestQueueConfig::default(), || NOW)
}

fn com_obra(imdb: &str) -> HarvestQueue {
    let mut queue = fila();
    assert!(queue.enqueue(HarvestRequest::movie(imdb, "miss")).accepted);
    queue
}

/// Consome a cabeça e abre o claim — o que o `worker.begin` faz.
fn reivindica(queue: &mut HarvestQueue) -> HarvestEntry {
    let entry = queue.take_head().expect("cabeça");
    queue.claim_durable(&entry, NOW);
    entry
}

#[test]
fn restart_devolve_o_slot_a_fila() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = com_obra("tt0111161");
    assert!(
        queue
            .enqueue(HarvestRequest::movie("tt0068646", "miss"))
            .accepted
    );
    let in_flight = reivindica(&mut queue);
    queue
        .save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, NOW)
        .unwrap();
    assert_eq!(queue.depth(), 1, "a obra em voo saiu da memória");

    // Processo novo: o dono do slot morreu, então ele volta SEM esperar o TTL.
    let mut restarted = fila();
    restarted.load_from(&store, NOW + 5_000, None).unwrap();
    assert!(restarted.lease().is_none(), "slot do processo morto fecha");
    assert_eq!(restarted.depth(), 2);
    assert!(restarted
        .find_queued(&in_flight.imdb_id, None, None)
        .is_some());
    assert_eq!(restarted.slot.attempts[&entry_identity(&in_flight)], 1);
}

#[test]
fn save_durante_o_drain_nao_perde_a_obra_em_voo() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = com_obra("tt0111161");
    let in_flight = reivindica(&mut queue);
    // Espelho do enqueue do Node no meio do drain: ele persiste a fila AGORA.
    assert!(
        queue
            .enqueue(HarvestRequest::movie("tt0068646", "miss"))
            .accepted
    );
    queue
        .save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, NOW)
        .unwrap();

    let mut restarted = fila();
    restarted.load_from(&store, NOW + 5_000, None).unwrap();
    assert_eq!(restarted.depth(), 2, "a que estava em voo não se perdeu");
    assert!(restarted
        .find_queued(&in_flight.imdb_id, None, None)
        .is_some());
}

#[test]
fn documento_com_so_o_slot_nao_some() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = com_obra("tt0111161");
    reivindica(&mut queue);
    queue
        .save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, NOW)
        .unwrap();
    assert!(
        store.has_queue(NOW).unwrap(),
        "fila vazia + slot vivo = chave viva"
    );
}

#[test]
fn finish_fecha_o_slot_e_e_idempotente() {
    let mut queue = com_obra("tt0111161");
    let in_flight = reivindica(&mut queue);
    let id = entry_identity(&in_flight);
    queue.finish_durable(&id);
    queue.finish_durable(&id);
    assert!(queue.lease().is_none());
    assert!(queue.terminal().is_empty(), "fechar não é morte de claim");
    assert!(queue.slot.attempts.is_empty(), "contador zerado ao fechar");
}

#[test]
fn tres_mortes_em_voo_vao_para_terminal() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = com_obra("tt0111161");
    for _ in 0..MAX_CLAIM_ATTEMPTS {
        reivindica(&mut queue);
        queue
            .save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, NOW)
            .unwrap();
        let mut restarted = fila();
        restarted.load_from(&store, NOW + 1_000, None).unwrap();
        queue = restarted;
    }
    assert_eq!(queue.depth(), 0, "não volta mais para a fila");
    assert_eq!(queue.terminal().len(), 1);
    assert_eq!(queue.terminal()[0].reason, "lease_expired");
}

#[test]
fn terminal_expira_do_slot() {
    let entry = com_obra("tt0111161").take_head().expect("cabeça");
    let mut slot = DurableSlot::default();
    slot.terminal.push(TerminalEntry {
        entry_id: entry_identity(&entry),
        entry,
        reason: "lease_expired".to_string(),
        at_ms: NOW,
    });
    let velho = NOW + (TERMINAL_TTL_SECONDS as i64) * 1_000;
    assert!(slot.reclaim(velho).is_none());
    assert!(slot.terminal().is_empty(), "terminal velho não fica pago");
}

#[test]
fn claim_sem_finish_volta_anticipada() {
    let mut queue = com_obra("tt0111161");
    let primeiro = reivindica(&mut queue);
    // Future cancelado no meio: o slot fica aberto e o próximo tick abre outro.
    assert!(
        queue
            .enqueue(HarvestRequest::movie("tt0068646", "miss"))
            .accepted
    );
    reivindica(&mut queue);
    assert_eq!(
        queue.slot.attempts[&entry_identity(&primeiro)],
        1,
        "a morte conta antes de o novo claim abrir"
    );
    assert!(
        queue.find_queued(&primeiro.imdb_id, None, None).is_some(),
        "a obra do slot órfão volta à fila"
    );
    assert!(queue.lease().is_some());
}

#[test]
fn clear_nao_devolve_o_slot() {
    let mut queue = com_obra("tt0111161");
    reivindica(&mut queue);
    assert_eq!(queue.clear(), 0);
    assert!(queue.lease().is_none());
    assert!(queue.terminal().is_empty(), "zerar não é poison");
}

#[test]
fn documento_no_formato_antigo_ainda_carrega() {
    let store = HarvestStore::open_memory().unwrap();
    // Array cru (formato anterior ao T1-B1), como está no L2 das instalações.
    store
        .put_raw_for_test(
            r#"[{"imdbId":"tt0111161","type":"movie","reason":"miss","enqueuedAt":1}]"#,
            NOW + 600_000,
        )
        .unwrap();
    let mut queue = fila();
    queue.load_from(&store, NOW, None).unwrap();
    assert_eq!(queue.depth(), 1, "upgrade não pode perder a fila");
    assert!(queue.lease().is_none());
}
