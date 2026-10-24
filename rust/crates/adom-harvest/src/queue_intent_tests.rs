use super::*;
use crate::store::{HarvestStore, DEFAULT_ENTRY_TTL_SECONDS};
use crate::types::HarvestMediaType;

fn clock_fixed() -> i64 {
    1_700_000_000_000
}

fn q(max: usize) -> HarvestQueue {
    HarvestQueue::with_clock(
        HarvestQueueConfig {
            queue_max: max,
            ..HarvestQueueConfig::default()
        },
        clock_fixed,
    )
}

fn probe_req(imdb: &str, reason: &str) -> HarvestRequest {
    let mut req = HarvestRequest::movie(imdb, reason);
    req.br_probe = true;
    req
}

#[test]
fn sonda_aceita_full_mais_fraca_sem_perder_obrigacao() {
    let mut queue = HarvestQueue::new(HarvestQueueConfig::default());
    let mut probe = HarvestRequest::movie("tt0111161", "br-gap");
    probe.br_probe = true;
    assert!(queue.enqueue(probe).accepted);
    assert!(
        queue
            .enqueue(HarvestRequest::movie("tt0111161", "miss"))
            .accepted
    );
    let entry = &queue.entries()[0];
    assert!(entry.br_probe);
    assert!(entry.full_base);
    assert_eq!(entry.reason, "br-gap");
}

#[test]
fn matriz_full_sonda_misto() {
    let mut queue = q(10);
    assert_eq!(
        queue
            .enqueue(HarvestRequest::movie("tt0111161", "miss"))
            .reason,
        EnqueueReason::Queued
    );
    assert_eq!(
        queue.enqueue(probe_req("tt0111161", "miss")).reason,
        EnqueueReason::Queued
    );
    let pf = &queue.entries()[0];
    assert!(pf.br_probe && pf.full_base);
    assert_eq!(pf.pending_full().unwrap().reason, "miss");

    assert_eq!(
        queue
            .enqueue(HarvestRequest::movie("tt0111161", "br-gap"))
            .reason,
        EnqueueReason::Promoted
    );
    assert_eq!(queue.entries()[0].reason, "br-gap");
    assert_eq!(queue.entries()[0].pending_full().unwrap().reason, "br-gap");

    let mut other = q(10);
    other.enqueue(probe_req("tt0111161", "br-gap"));
    assert_eq!(
        other
            .enqueue(HarvestRequest::movie("tt0111161", "miss"))
            .reason,
        EnqueueReason::Queued
    );
    assert_eq!(other.entries()[0].reason, "br-gap");
    assert_eq!(other.entries()[0].pending_full().unwrap().reason, "miss");
}

#[test]
fn identidade_separa_episodios() {
    let mut queue = q(10);
    queue.enqueue(HarvestRequest::series("tt0903747", 1, Some(1), "miss"));
    queue.enqueue(HarvestRequest::series("tt0903747", 1, Some(2), "miss"));
    assert_eq!(queue.depth(), 2);
    let mut probe = HarvestRequest::series("tt0903747", 1, Some(1), "br-gap");
    probe.br_probe = true;
    queue.enqueue(probe);
    assert_eq!(queue.depth(), 2);
    let e1 = queue.find_queued("tt0903747", Some(1), Some(1)).unwrap();
    assert!(e1.br_probe && e1.full_base);
    let e2 = queue.find_queued("tt0903747", Some(1), Some(2)).unwrap();
    assert!(!e2.br_probe && !e2.full_base);
}

#[test]
fn promocao_preserva_idade_e_empate_nao_renova_priority() {
    let mut queue = q(10);
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    let first_at = queue.entries()[0].enqueued_at;
    queue.enqueue(HarvestRequest::movie("tt0111161", "br-gap"));
    let after = &queue.entries()[0];
    assert_eq!(after.enqueued_at, first_at);
    assert_eq!(after.priority_at, Some(clock_fixed()));

    let mut weaker = HarvestRequest::movie("tt0111161", "popular");
    weaker.br_probe = true;
    queue.enqueue(weaker);
    assert_eq!(queue.entries()[0].enqueued_at, first_at);
    assert_eq!(queue.entries()[0].priority_at, Some(clock_fixed()));
}

#[test]
fn head_e_tail_fundem_full_sobre_sonda() {
    let mut queue = q(10);
    queue.enqueue(probe_req("tt0111161", "br-gap"));
    let incoming = HarvestEntry {
        imdb_id: "tt0111161".into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "miss".into(),
        enqueued_at: clock_fixed() + 10,
        priority_at: None,
        resumed: false,
        br_probe: false,
        full_base: false,
        full_intent: None,
    };
    queue.head(incoming.clone());
    assert_eq!(queue.depth(), 1);
    assert!(queue.entries()[0].full_base);
    assert_eq!(queue.entries()[0].pending_full().unwrap().reason, "miss");
    assert_eq!(queue.entries()[0].enqueued_at, clock_fixed());

    queue.tail(incoming);
    assert_eq!(queue.depth(), 1);
    assert!(queue.entries()[0].full_base);
}

#[test]
fn retorno_acima_do_teto_sobrevive_ao_save_load() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = q(1);
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    let first = queue.take_head().unwrap();
    queue.enqueue(HarvestRequest::movie("tt0068646", "miss"));
    queue.tail(first);
    assert_eq!(queue.depth(), 2);
    queue
        .save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, clock_fixed())
        .unwrap();

    let mut loaded = q(1);
    loaded.load_from(&store, clock_fixed(), None).unwrap();
    assert_eq!(loaded.depth(), 2);
    let ids: Vec<_> = loaded
        .entries()
        .iter()
        .map(|e| e.imdb_id.as_str())
        .collect();
    assert!(ids.contains(&"tt0111161"));
    assert!(ids.contains(&"tt0068646"));
}

#[test]
fn reduzir_teto_nao_corta_save_load() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = q(3);
    queue.enqueue(HarvestRequest::movie("tt0000001", "miss"));
    queue.enqueue(HarvestRequest::movie("tt0000002", "miss"));
    queue.enqueue(HarvestRequest::movie("tt0000003", "miss"));
    queue.set_config(HarvestQueueConfig {
        queue_max: 1,
        ..HarvestQueueConfig::default()
    });
    queue
        .save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, clock_fixed())
        .unwrap();
    let mut loaded = q(1);
    loaded.load_from(&store, clock_fixed(), None).unwrap();
    assert_eq!(loaded.depth(), 3);
}
