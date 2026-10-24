use super::*;
use crate::queue::{HarvestQueue, HarvestQueueConfig};
use crate::types::{HarvestMediaType, HarvestRequest};

fn clock_fixed() -> i64 {
    1_700_000_000_000
}

#[test]
fn envelope_guarda_obrigacao_full_com_motivo_efetivo_mais_forte() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = HarvestQueue::with_clock(HarvestQueueConfig::default(), clock_fixed);
    let mut probe = HarvestRequest::movie("tt0111161", "br-gap");
    probe.br_probe = true;
    queue.enqueue(probe);
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    queue
        .save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, clock_fixed())
        .unwrap();

    let mut loaded = HarvestQueue::with_clock(HarvestQueueConfig::default(), clock_fixed);
    loaded.load_from(&store, clock_fixed(), None).unwrap();
    let entry = &loaded.entries()[0];
    assert_eq!(entry.reason, "br-gap");
    assert!(entry.br_probe && entry.full_base);
    assert_eq!(entry.pending_full().unwrap().reason, "miss");
}

#[test]
fn json_publico_omite_full_intent() {
    let entry = HarvestEntry {
        imdb_id: "tt0111161".into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "br-gap".into(),
        enqueued_at: clock_fixed(),
        priority_at: Some(clock_fixed()),
        resumed: false,
        br_probe: true,
        full_base: true,
        full_intent: Some(crate::types::PendingFull {
            reason: "miss".into(),
            priority_at: None,
        }),
    };
    let public = serde_json::to_value(&entry).unwrap();
    assert!(public.get("fullIntent").is_none());
    assert_eq!(public["fullBase"], true);
}

#[test]
fn legado_full_base_sem_snapshot_sintetiza_motivo_disponivel() {
    let store = HarvestStore::open_memory().unwrap();
    store
        .put_raw_for_test(
            r#"[{"imdbId":"tt0111161","type":"movie","reason":"br-gap","enqueuedAt":1,"priorityAt":1,"brProbe":true,"fullBase":true}]"#,
            clock_fixed() + 60_000,
        )
        .unwrap();
    let loaded = store.load(clock_fixed()).unwrap();
    assert_eq!(loaded.len(), 1);
    assert!(loaded[0].br_probe && loaded[0].full_base);
    assert_eq!(loaded[0].pending_full().unwrap().reason, "br-gap");
}
