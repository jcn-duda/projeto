//! Uma iteração real de `run_iteration` com drain de barreira (sem sleep).
//! Restart lê a fila persistida; não é recuperação de crash no meio da rede.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

use adom_harvest::{
    load_hour, probe_key, BrProbe, BrProbeState, BrProbeWork, DrainOutcome, EnqueueReason,
    HarvestDrainAsync, HarvestEntry, HarvestQueue, HarvestQueueConfig, HarvestRequest,
    HarvestStore, HarvestWorker, HarvestWorkerConfig, ProbeConfig, DEDUPE_TTL_SECONDS, HOUR_MS,
};
use tokio::sync::oneshot;

use super::{persist_hour, run_iteration, DrainFound, Inner, IterationOutcome};
use crate::harvest::config::HarvestConfig;
use crate::harvest::enqueue::enqueue_with_dedupe;
use crate::harvest::evidence::EvidenceSnapshot;
use crate::harvest::settle::Settler;
use crate::harvest::status::HarvestStatus;
use crate::harvest::traffic::StreamTraffic;

const NOW: i64 = 1_700_000_000_000;
const SHAW: &str = "tt0111161";
const PADRINO: &str = "tt0068646";

struct BarrierDrain {
    entered: Option<oneshot::Sender<()>>,
    release: Option<oneshot::Receiver<()>>,
    queries: u32,
    ok: bool,
}

impl HarvestDrainAsync for BarrierDrain {
    fn drain_one<'a>(
        &'a mut self,
        _entry: &'a HarvestEntry,
        _queries_left: u32,
    ) -> Pin<Box<dyn Future<Output = DrainOutcome> + Send + 'a>> {
        let entered = self.entered.take();
        let release = self.release.take();
        let queries = self.queries;
        let ok = self.ok;
        Box::pin(async move {
            if let Some(tx) = entered {
                let _ = tx.send(());
            }
            if let Some(rx) = release {
                let _ = rx.await;
            }
            DrainOutcome { ok, queries }
        })
    }
}

impl DrainFound for BarrierDrain {}

struct ImmediateDrain {
    ok: bool,
    queries: u32,
}

impl HarvestDrainAsync for ImmediateDrain {
    fn drain_one<'a>(
        &'a mut self,
        _entry: &'a HarvestEntry,
        _queries_left: u32,
    ) -> Pin<Box<dyn Future<Output = DrainOutcome> + Send + 'a>> {
        let outcome = DrainOutcome {
            ok: self.ok,
            queries: self.queries,
        };
        Box::pin(async move { outcome })
    }
}

impl DrainFound for ImmediateDrain {}

fn worker() -> HarvestWorker {
    HarvestWorker::new(HarvestWorkerConfig {
        enabled: true,
        max_per_hour: 1_000,
    })
}

fn probe_req(imdb: &str) -> HarvestRequest {
    let mut req = HarvestRequest::movie(imdb, "br-gap");
    req.br_probe = true;
    req
}

fn test_inner(store: Arc<HarvestStore>, ttl: u64) -> Arc<Inner> {
    let config = HarvestConfig {
        entry_ttl: ttl,
        ..HarvestConfig::default()
    };
    let queue = HarvestQueue::new(HarvestQueueConfig {
        enabled: true,
        queue_max: config.queue_max,
        br_first: config.br_first,
        br_max_wait_ms: config.br_max_wait_ms,
    });
    Arc::new(Inner {
        env: config.clone(),
        config: Mutex::new(config),
        live_dirty: AtomicBool::new(false),
        store,
        store_path: PathBuf::from("harvest-loop-test"),
        queue: tokio::sync::Mutex::new(queue),
        status: Mutex::new(HarvestStatus::default()),
        paused: AtomicBool::new(false),
        traffic: StreamTraffic::new(Arc::new(std::sync::atomic::AtomicI64::new(0)), 0),
        notify: tokio::sync::Notify::new(),
        drain_budget: AtomicUsize::new(0),
        drain_reply: Mutex::new(None),
        index: None,
        evidence: Mutex::new(EvidenceSnapshot::default()),
    })
}

fn peek_probe(store: &HarvestStore, imdb: &str, now: i64) -> Option<BrProbeState> {
    let probe = BrProbe::new(ProbeConfig {
        index_only_indexers: vec!["x".into()],
        pt_br_indexers: vec!["x".into()],
        ..ProbeConfig::default()
    });
    probe
        .state(
            store,
            &BrProbeWork {
                media_type: adom_harvest::HarvestMediaType::Movie,
                imdb_id: imdb.into(),
                season: None,
                episode: None,
            },
            now,
        )
        .expect("sonda")
}

#[tokio::test]
async fn barreira_coalesce_mesma_obra_e_preserva_a_outra() {
    let store = Arc::new(HarvestStore::open_memory().unwrap());
    let inner = test_inner(store.clone(), 86_400);
    {
        let mut queue = inner.queue.lock().await;
        assert!(enqueue_with_dedupe(&mut queue, &store, probe_req(SHAW), NOW, None).accepted);
    }
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let mut drain = BarrierDrain {
        entered: Some(entered_tx),
        release: Some(release_rx),
        queries: 2,
        ok: true,
    };
    let loop_inner = inner.clone();
    let task = tokio::spawn(async move {
        let mut worker = worker();
        let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
        let outcome = run_iteration(&loop_inner, &mut worker, &mut drain, &mut settler, NOW).await;
        persist_hour(&loop_inner, &mut worker, NOW);
        (outcome, worker)
    });
    entered_rx.await.expect("drain entrou");
    {
        let mut queue = inner.queue.lock().await;
        let full = enqueue_with_dedupe(
            &mut queue,
            &store,
            HarvestRequest::movie(SHAW, "miss"),
            NOW,
            None,
        );
        assert_eq!(full.reason, EnqueueReason::Coalesced);
        let again = enqueue_with_dedupe(&mut queue, &store, probe_req(SHAW), NOW, None);
        assert!(
            again.reason == EnqueueReason::Coalesced || again.reason == EnqueueReason::Duplicate
        );
        let other = enqueue_with_dedupe(
            &mut queue,
            &store,
            HarvestRequest::movie(PADRINO, "miss"),
            NOW,
            None,
        );
        assert_eq!(other.reason, EnqueueReason::Queued);
        assert!(queue.find_queued(SHAW, None, None).is_none());
        assert!(queue.find_queued(PADRINO, None, None).is_some());
    }
    release_tx.send(()).expect("soltar");
    let (outcome, mut worker) = task.await.expect("iteração");
    assert_eq!(outcome, IterationOutcome::Drained { ok: true });
    persist_hour(&inner, &mut worker, NOW);

    let queue = inner.queue.lock().await;
    assert_eq!(queue.depth(), 2);
    let rem = queue
        .find_queued(SHAW, None, None)
        .expect("FULL remanescente");
    assert!(!rem.br_probe);
    assert_eq!(rem.reason, "miss");
    assert!(queue.find_queued(PADRINO, None, None).is_some());
    drop(queue);

    assert_eq!(peek_probe(&store, SHAW, NOW), Some(BrProbeState::Empty));
    assert_eq!(load_hour(&store, NOW).unwrap().map(|h| h.count), Some(2));
    let loaded = store.load(NOW).unwrap();
    assert_eq!(loaded.len(), 2);
    assert!(loaded.iter().any(|e| e.imdb_id == SHAW && !e.br_probe));

    let mut restarted = HarvestQueue::new(HarvestQueueConfig::default());
    restarted.load_from(&store, NOW, None).unwrap();
    assert_eq!(restarted.depth(), 2);
    assert!(!restarted.find_queued(SHAW, None, None).unwrap().br_probe);

    let public = serde_json::to_value(inner.status.lock().unwrap().preview.clone()).unwrap();
    assert!(public
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.get("fullIntent").is_none()));
    assert!(store
        .get_value(
            &probe_key(&BrProbeWork {
                media_type: adom_harvest::HarvestMediaType::Movie,
                imdb_id: SHAW.into(),
                season: None,
                episode: None,
            }),
            NOW,
        )
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn restart_apos_save_reconstroi_fila_e_dedupe() {
    let store = Arc::new(HarvestStore::open_memory().unwrap());
    let inner = test_inner(store.clone(), 86_400);
    {
        let mut queue = inner.queue.lock().await;
        assert!(
            enqueue_with_dedupe(
                &mut queue,
                &store,
                HarvestRequest::movie(SHAW, "miss"),
                NOW,
                None
            )
            .accepted
        );
    }
    let mut worker = worker();
    let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
    let mut drain = ImmediateDrain {
        ok: true,
        queries: 1,
    };
    assert_eq!(
        run_iteration(&inner, &mut worker, &mut drain, &mut settler, NOW).await,
        IterationOutcome::Drained { ok: true }
    );
    persist_hour(&inner, &mut worker, NOW);
    assert_eq!(inner.queue.lock().await.depth(), 0);

    let again = {
        let mut queue = inner.queue.lock().await;
        enqueue_with_dedupe(
            &mut queue,
            &store,
            HarvestRequest::movie(SHAW, "miss"),
            NOW,
            None,
        )
    };
    assert_eq!(again.reason, EnqueueReason::Dedupe);

    let later = {
        let mut queue = inner.queue.lock().await;
        enqueue_with_dedupe(
            &mut queue,
            &store,
            HarvestRequest::movie(SHAW, "miss"),
            NOW + (DEDUPE_TTL_SECONDS as i64) * 1_000 + 1,
            None,
        )
    };
    assert_eq!(later.reason, EnqueueReason::Queued);
}

#[tokio::test]
async fn ttl_da_fila_e_balde_da_hora() {
    let store = Arc::new(HarvestStore::open_memory().unwrap());
    let inner = test_inner(store.clone(), 1);
    {
        let mut queue = inner.queue.lock().await;
        assert!(
            enqueue_with_dedupe(
                &mut queue,
                &store,
                HarvestRequest::movie(SHAW, "miss"),
                NOW,
                None
            )
            .accepted
        );
        inner.persist_queue(&queue, NOW);
    }
    let mut alive = HarvestQueue::new(HarvestQueueConfig::default());
    alive.load_from(&store, NOW + 999, None).unwrap();
    assert_eq!(alive.depth(), 1);
    let mut expired = HarvestQueue::new(HarvestQueueConfig::default());
    expired.load_from(&store, NOW + 1_000, None).unwrap();
    assert_eq!(expired.depth(), 0);

    let inner = test_inner(store.clone(), 86_400);
    {
        let mut queue = inner.queue.lock().await;
        assert!(
            enqueue_with_dedupe(
                &mut queue,
                &store,
                HarvestRequest::movie(PADRINO, "miss"),
                NOW,
                None
            )
            .accepted
        );
    }
    let mut worker = worker();
    let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
    let mut drain = ImmediateDrain {
        ok: true,
        queries: 4,
    };
    assert_eq!(
        run_iteration(&inner, &mut worker, &mut drain, &mut settler, NOW).await,
        IterationOutcome::Drained { ok: true }
    );
    let hour_now = 472_222 * HOUR_MS;
    persist_hour(&inner, &mut worker, hour_now);
    assert_eq!(
        load_hour(&store, hour_now).unwrap().map(|h| h.count),
        Some(4)
    );
    assert_eq!(load_hour(&store, hour_now + HOUR_MS).unwrap(), None);
    assert_eq!(worker.queries_this_hour(hour_now + HOUR_MS), 0);
    let saved = load_hour(&store, hour_now).unwrap().expect("balde da hora");
    let mut fresh = HarvestWorker::new(HarvestWorkerConfig {
        enabled: true,
        max_per_hour: 1_000,
    });
    fresh.hydrate_hour(saved.count, hour_now);
    assert_eq!(fresh.queries_this_hour(hour_now), 4);
}
