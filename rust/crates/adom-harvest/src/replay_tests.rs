//! Testes do replay de boot (T1-B3): run interrompido tem que fechar no
//! journal e a obra tem que voltar à fila UMA vez.
//!
//! Cenário-raiz: o processo morre com o run `running` e o slot durável no
//! documento. Sem replay o painel mostra `running` por 24 h; com replay
//! errado a obra entra duas vezes na fila ou o slot é duplicado.

use super::*;
use crate::lease::LEASE_TTL_MS;
use crate::queue::{HarvestQueue, HarvestQueueConfig};
use crate::run_id::new_run_id;
use crate::store::DEFAULT_ENTRY_TTL_SECONDS;
use crate::types::HarvestRequest;

const NOW: i64 = 1_700_000_000_000;

fn fila() -> HarvestQueue {
    // Relógio fixo: o teste não depende do tempo real (o `now` do claim vai
    // explícito em cada chamada).
    HarvestQueue::with_clock(HarvestQueueConfig::default(), || NOW)
}

/// Simula a morte no meio do drain: a obra saiu da memória, o slot e o journal
/// do MESMO `run_id` ficaram no L2.
fn com_run_interrompido(store: &HarvestStore, now: i64) -> InflightEntry {
    let mut queue = fila();
    assert!(
        queue
            .enqueue(HarvestRequest::movie("tt0111161", "miss"))
            .accepted
    );
    let entry = queue.take_head().expect("cabeça");
    let run_id = queue.claim_durable(&entry, now);
    store.journal_begin(&run_id, &entry.imdb_id, now).unwrap();
    store.journal_step(&run_id, "index", now + 1).unwrap();
    queue
        .save_to(store, DEFAULT_ENTRY_TTL_SECONDS, now)
        .unwrap();
    queue.lease().expect("slot aberto").clone()
}

#[test]
fn pending_runs_lista_so_o_que_ficou_aberto() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("run-1", "tt1", 1_000).unwrap();
    store.journal_step("run-1", "index", 1_100).unwrap();
    store.journal_begin("run-2", "tt2", 1_200).unwrap();
    store.journal_finish("run-2", "done", 1_300).unwrap();

    let pendentes = pending_runs(&store, 2_000).unwrap();
    assert_eq!(pendentes.len(), 1);
    assert_eq!(pendentes[0].run_id, "run-1");
    assert_eq!(pendentes[0].obra, "tt1");
    assert_eq!(pendentes[0].steps, vec!["index".to_string()]);
    assert!(!pendentes[0].missing_step("index"), "já executado");
    assert!(pendentes[0].missing_step("invalidated"));
}

#[test]
fn replay_retoma_o_run_com_slot_e_nao_cria_segundo() {
    let store = HarvestStore::open_memory().unwrap();
    let slot = com_run_interrompido(&store, NOW);

    let relatorio = replay_pending(&store, NOW + 5_000).unwrap();
    assert_eq!(relatorio.pending, 1);
    assert_eq!(relatorio.replayed(), 1);
    assert_eq!(relatorio.resumed[0].entry_id, slot.entry_id);
    assert_eq!(relatorio.pending_after(), 0);

    let run = store
        .journal_get(&slot.lease.run_id, NOW + 5_000)
        .unwrap()
        .unwrap();
    assert_eq!(run.status, "failed");
    assert_eq!(run.reason.as_deref(), Some("interrupted"));
    assert_eq!(run.steps, vec!["index".to_string()], "passos preservados");

    // O replay não mexe no slot: quem devolve a obra à fila é o `load_from`.
    let stored = store.load_queue(NOW + 5_000).unwrap();
    assert_eq!(
        stored.inflight.as_ref().map(|slot| &slot.entry_id),
        Some(&slot.entry_id),
        "um slot só"
    );
    let mut queue = fila();
    queue.load_from(&store, NOW + 5_000, None).unwrap();
    assert_eq!(queue.depth(), 1, "uma obra, não duas");
    assert!(queue.lease().is_none());
}

#[test]
fn lease_vencida_ainda_retoma_mas_marca_lease_expired() {
    let store = HarvestStore::open_memory().unwrap();
    let slot = com_run_interrompido(&store, NOW);
    let depois = NOW + LEASE_TTL_MS + 1;

    let relatorio = replay_pending(&store, depois).unwrap();
    assert_eq!(
        relatorio.replayed(),
        1,
        "a obra volta mesmo com a lease vencida"
    );
    let run = store
        .journal_get(&slot.lease.run_id, depois)
        .unwrap()
        .unwrap();
    assert_eq!(run.reason.as_deref(), Some("lease_expired"));
}

#[test]
fn run_sem_slot_fecha_como_orfao() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("h-1-0-999", "tt1", NOW).unwrap();

    let relatorio = replay_pending(&store, NOW + 10).unwrap();
    assert_eq!(relatorio.pending, 1);
    assert!(relatorio.resumed.is_empty());
    assert_eq!(relatorio.orphans, 1);
    assert_eq!(relatorio.pending_after(), 0);

    let run = store.journal_get("h-1-0-999", NOW + 11).unwrap().unwrap();
    assert_eq!(run.status, "failed");
    assert_eq!(run.reason.as_deref(), Some("orphan"));
}

#[test]
fn replay_e_idempotente() {
    let store = HarvestStore::open_memory().unwrap();
    com_run_interrompido(&store, NOW);
    replay_pending(&store, NOW + 10).unwrap();

    let segundo = replay_pending(&store, NOW + 20).unwrap();
    assert_eq!(segundo.pending, 0, "run fechado não volta para a lista");
    assert!(segundo.resumed.is_empty());
    assert_eq!(segundo.orphans, 0);
}

#[test]
fn run_id_e_unico_e_identifica_o_processo() {
    let a = new_run_id(1_000);
    let b = new_run_id(1_000);
    assert_ne!(a, b);
    assert!(a.starts_with(crate::run_id::RUN_ID_PREFIX));
    assert!(
        a.ends_with(&format!("-{}", std::process::id())),
        "pid no sufixo: run de sessão morta é reconhecível no log"
    );
}
