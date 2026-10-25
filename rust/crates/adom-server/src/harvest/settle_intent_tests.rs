//! Settlement com obrigação FULL: begin/finish + Settler, não só tick_async.

use adom_harvest::{
    entry_identity, DrainOutcome, HarvestEntry, HarvestIntent, HarvestMediaType, HarvestQueue,
    HarvestQueueConfig, HarvestRequest, HarvestStore, HarvestWorker, HarvestWorkerConfig,
    PendingFull, PendingIntent, DEFAULT_PROBE_TTL_SECONDS,
};

use super::{Settlement, Settler};

const NOW: i64 = 1_700_000_000_000;

fn settler() -> Settler {
    Settler::new(DEFAULT_PROBE_TTL_SECONDS)
}

fn queue() -> HarvestQueue {
    HarvestQueue::with_clock(HarvestQueueConfig::default(), || NOW)
}

fn worker() -> HarvestWorker {
    HarvestWorker::new(HarvestWorkerConfig::default())
}

fn probe_req(imdb: &str, reason: &str) -> HarvestRequest {
    let mut req = HarvestRequest::movie(imdb, reason);
    req.br_probe = true;
    req
}

fn settlement(intent: Option<PendingIntent>, ok: bool) -> Settlement {
    Settlement {
        intent,
        ok,
        br_found: false,
    }
}

fn run_once(
    worker: &mut HarvestWorker,
    queue: &mut HarvestQueue,
    settler: &mut Settler,
    store: &HarvestStore,
    coalesce: Option<HarvestRequest>,
    ok: bool,
) -> HarvestEntry {
    let start = match worker.begin(queue, &false, NOW) {
        adom_harvest::TickStart::Run {
            entry, identity, ..
        } => (entry, identity),
        other => panic!("esperado Run, got {other:?}"),
    };
    if let Some(req) = coalesce {
        assert!(queue.enqueue(req).accepted);
    }
    let intent = queue.inflight().pending(&start.1);
    worker.finish(queue, &start.1, DrainOutcome { ok, queries: 1 }, NOW);
    let entry = start.0;
    settler.settle(queue, store, entry.clone(), settlement(intent, ok), NOW);
    entry
}

#[test]
fn sonda_coalesce_full_antes_do_finish_devolve_uma_full() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut worker = worker();
    let mut settler = settler();
    queue.enqueue(probe_req("tt0111161", "br-gap"));
    run_once(
        &mut worker,
        &mut queue,
        &mut settler,
        &store,
        Some(HarvestRequest::movie("tt0111161", "miss")),
        true,
    );
    assert_eq!(queue.depth(), 1);
    let left = &queue.entries()[0];
    assert!(!left.br_probe);
    assert!(!left.full_base);
    assert_eq!(left.reason, "miss");
    assert_eq!(left.imdb_id, "tt0111161");
}

#[test]
fn full_bem_sucedida_nao_deixa_residuo() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut worker = worker();
    let mut settler = settler();
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    run_once(
        &mut worker,
        &mut queue,
        &mut settler,
        &store,
        Some(probe_req("tt0111161", "br-gap")),
        true,
    );
    assert_eq!(queue.depth(), 0);
}

#[test]
fn falha_da_sonda_com_full_devolve_full_preservada() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut worker = worker();
    let mut settler = settler();
    queue.enqueue(probe_req("tt0111161", "br-gap"));
    run_once(
        &mut worker,
        &mut queue,
        &mut settler,
        &store,
        Some(HarvestRequest::movie("tt0111161", "miss")),
        false,
    );
    assert_eq!(queue.depth(), 1);
    let left = &queue.entries()[0];
    assert!(!left.br_probe);
    assert_eq!(left.reason, "miss");
}

#[test]
fn falha_full_com_sonda_anexada_nao_rebaixa_retry() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut worker = worker();
    let mut settler = settler();
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    run_once(
        &mut worker,
        &mut queue,
        &mut settler,
        &store,
        Some(probe_req("tt0111161", "br-gap")),
        false,
    );
    assert_eq!(queue.depth(), 1);
    let left = &queue.entries()[0];
    assert!(!left.br_probe);
    assert_eq!(left.reason, "br-gap");
}

#[test]
fn sucesso_zera_tentativas_mesmo_com_remanescente() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();
    let entry = HarvestEntry {
        imdb_id: "tt0111161".into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "br-gap".into(),
        enqueued_at: NOW,
        priority_at: Some(NOW),
        resumed: false,
        br_probe: true,
        full_base: true,
        full_intent: Some(PendingFull {
            reason: "miss".into(),
            priority_at: None,
        }),
    };
    let intent = Some(PendingIntent {
        reason: "br-gap".into(),
        br_probe: true,
        priority_at: Some(NOW),
        full: Some(PendingFull {
            reason: "miss".into(),
            priority_at: None,
        }),
    });
    settler.settle(
        &mut queue,
        &store,
        entry.clone(),
        settlement(intent.clone(), false),
        NOW,
    );
    settler.settle(
        &mut queue,
        &store,
        entry.clone(),
        settlement(intent.clone(), false),
        NOW,
    );
    queue.clear();
    settler.settle(&mut queue, &store, entry, settlement(intent, true), NOW);
    assert_eq!(queue.depth(), 1);
    assert!(!queue.entries()[0].br_probe);
    for round in 1..=3 {
        let retry = queue.take_head().unwrap();
        settler.settle(&mut queue, &store, retry, settlement(None, false), NOW);
        assert_eq!(queue.depth(), 1, "rodada {round} deveria reenfileirar");
    }
}

#[test]
fn quarta_falha_descarta() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();
    let entry = HarvestEntry {
        imdb_id: "tt0068646".into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "miss".into(),
        enqueued_at: NOW,
        priority_at: None,
        resumed: false,
        br_probe: false,
        full_base: false,
        full_intent: None,
    };
    for _ in 1..=3 {
        settler.settle(
            &mut queue,
            &store,
            entry.clone(),
            settlement(HarvestIntent::from_entry(&entry).into_pending(), false),
            NOW,
        );
        assert_eq!(queue.depth(), 1);
        queue.take_head();
    }
    settler.settle(&mut queue, &store, entry, settlement(None, false), NOW);
    assert_eq!(queue.depth(), 0);
}

#[test]
fn remanescente_full_nao_drena_como_sonda_sob_trafego() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut worker = worker();
    let mut settler = settler();
    queue.enqueue(probe_req("tt0111161", "br-gap"));
    run_once(
        &mut worker,
        &mut queue,
        &mut settler,
        &store,
        Some(HarvestRequest::movie("tt0111161", "miss")),
        true,
    );
    assert_eq!(queue.depth(), 1);
    assert!(!queue.entries()[0].br_probe);
    let start = worker.begin(&mut queue, &true, NOW);
    assert!(matches!(start, adom_harvest::TickStart::Skip(_)));
    assert_eq!(queue.depth(), 1);
}

trait IntoPending {
    fn into_pending(self) -> Option<PendingIntent>;
}

impl IntoPending for HarvestIntent {
    fn into_pending(self) -> Option<PendingIntent> {
        Some(PendingIntent {
            reason: self.reason,
            br_probe: self.br_probe,
            priority_at: self.priority_at,
            full: self.full,
        })
    }
}

#[test]
fn identidade_diferente_nao_fecha_nem_absorve() {
    let mut queue = queue();
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    let taken = queue.take_head().unwrap();
    queue
        .inflight_mut()
        .begin(&entry_identity(&taken), HarvestIntent::from_entry(&taken));
    assert!(!queue
        .inflight_mut()
        .coalesce("tt0903747:1:2", &HarvestIntent::from_entry(&taken)));
    assert!(queue.inflight().is_inflight(&entry_identity(&taken)));
}
