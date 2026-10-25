use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::{Arc, Mutex};

use adom_harvest::{EnqueueReason, HarvestQueue, HarvestQueueConfig, HarvestRequest, HarvestStore};

use super::HarvestHandle;
use crate::harvest::config::HarvestConfig;
use crate::harvest::evidence::EvidenceSnapshot;
use crate::harvest::status::HarvestStatus;
use crate::harvest::traffic::StreamTraffic;
use crate::harvest::Inner;

fn persist_inner(store: Arc<HarvestStore>) -> Arc<Inner> {
    let config = HarvestConfig {
        entry_ttl: 86_400,
        ..HarvestConfig::default()
    };
    let queue = HarvestQueue::new(HarvestQueueConfig {
        enabled: true,
        queue_max: 4,
        br_first: true,
        br_max_wait_ms: config.br_max_wait_ms,
    });
    Arc::new(Inner {
        env: config.clone(),
        config: Mutex::new(config),
        live_dirty: AtomicBool::new(false),
        store,
        store_path: PathBuf::from("harvest-handle-test"),
        queue: tokio::sync::Mutex::new(queue),
        status: Mutex::new(HarvestStatus::default()),
        paused: AtomicBool::new(false),
        traffic: StreamTraffic::new(Arc::new(std::sync::atomic::AtomicI64::new(0)), 0),
        notify: tokio::sync::Notify::new(),
        preempt: tokio::sync::Notify::new(),
        inflight_rank: Mutex::new(None),
        drain_budget: AtomicUsize::new(0),
        drain_reply: Mutex::new(None),
        index: None,
        evidence: Mutex::new(EvidenceSnapshot::default()),
    })
}

#[tokio::test]
async fn eviccao_recusada_persiste_e_nao_ressuscita_no_reload() {
    let store = Arc::new(HarvestStore::open_memory().unwrap());
    let inner = persist_inner(store.clone());
    let handle = HarvestHandle {
        inner: inner.clone(),
    };
    for n in 1..=4 {
        let out = handle
            .enqueue(HarvestRequest::movie(format!("tt000000{n}"), "miss"))
            .await;
        assert!(out.accepted, "ingresso {n}");
    }
    {
        let mut queue = inner.queue.lock().await;
        queue.set_config(HarvestQueueConfig {
            queue_max: 2,
            br_first: true,
            ..HarvestQueueConfig::default()
        });
        assert_eq!(queue.depth(), 4, "reduzir teto não corta sozinho");
    }
    inner.replace_snapshot(EvidenceSnapshot::with_dubbed(&[
        "tt0000001",
        "tt0000002",
        "tt0000003",
        "tt0000004",
    ]));
    let rejected = handle
        .enqueue(HarvestRequest::movie("tt0000005", "miss"))
        .await;
    assert!(!rejected.accepted);
    assert_eq!(rejected.reason, EnqueueReason::Capacity);
    {
        let queue = inner.queue.lock().await;
        assert_eq!(queue.depth(), 2);
        let ids: Vec<_> = queue.preview(2).into_iter().map(|e| e.imdb_id).collect();
        assert!(!ids.contains(&"tt0000005".into()));
    }
    let mut reloaded = HarvestQueue::new(HarvestQueueConfig {
        queue_max: 2,
        br_first: true,
        ..HarvestQueueConfig::default()
    });
    reloaded
        .load_from(&store, adom_sources::now_ms(), None)
        .expect("reload");
    assert_eq!(
        reloaded.depth(),
        2,
        "L2 não devolve as entradas que a evicção já removeu"
    );
    let ids: Vec<_> = reloaded.preview(4).into_iter().map(|e| e.imdb_id).collect();
    assert!(!ids.contains(&"tt0000005".into()));
    assert_eq!(ids.len(), 2);
}
