//! Teto de coletas ao vivo (`live_slots.rs`): a fila segura a concorrência
//! no Jackett e solta a vaga só quando a coleta inteira assenta.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::LiveSlots;
use crate::orchestrator::tests::test_support::*;
use crate::orchestrator::*;

/// Coletor que mede quantas consultas estão abertas ao mesmo tempo.
#[derive(Default)]
struct PeakCollector {
    open: AtomicUsize,
    peak: AtomicUsize,
    calls: AtomicUsize,
}

impl Collector for PeakCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let now = self.open.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(80)).await;
            self.open.fetch_sub(1, Ordering::SeqCst);
            Ok(CollectBatch::default())
        })
    }
}

fn orch_with(slots: LiveSlots, collector: Arc<PeakCollector>) -> Orchestrator {
    let mut cfg = config();
    cfg.live_slots = slots;
    Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_collector(collector)
        .with_meta(Arc::new(StubMeta(meta())))
}

/// Três obras diferentes (chaves distintas: o coalescing não as junta).
async fn three_parallel(orch: &Orchestrator) {
    let ids = ["tt0000001", "tt0000002", "tt0000003"];
    let handles: Vec<_> = ids
        .iter()
        .map(|id| {
            let orch = orch.clone();
            let mut req = request(1_000_000);
            req.id = (*id).to_string();
            tokio::spawn(async move { orch.handle(req).await })
        })
        .collect();
    for handle in handles {
        handle.await.expect("busca não pode panicar");
    }
}

/// Pico de consultas de UMA busca sozinha (o plano pode gerar várias).
async fn single_peak() -> usize {
    let collector = Arc::new(PeakCollector::default());
    let orch = orch_with(LiveSlots::default(), collector.clone());
    let _ = orch.handle(request(1_000_000)).await;
    collector.peak.load(Ordering::SeqCst)
}

#[tokio::test]
async fn teto_de_uma_vaga_serializa_as_buscas() {
    let one = single_peak().await;
    assert!(one >= 1, "a busca precisa consultar o coletor");

    let collector = Arc::new(PeakCollector::default());
    let orch = orch_with(LiveSlots::new(1), collector.clone());
    three_parallel(&orch).await;
    assert!(
        collector.calls.load(Ordering::SeqCst) >= 3,
        "as três buscas coletam"
    );
    assert_eq!(
        collector.peak.load(Ordering::SeqCst),
        one,
        "com 1 vaga, nunca mais consultas abertas que as de uma busca só"
    );
    // A vaga sai na task do `completion`, que pode assentar logo depois da
    // resposta: espera curta em vez de exigir o mesmo instante.
    for _ in 0..100 {
        if orch.config.live_slots.in_use() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        orch.config.live_slots.in_use(),
        0,
        "a vaga volta ao fim da coleta"
    );
}

#[tokio::test]
async fn sem_teto_as_buscas_correm_juntas() {
    let one = single_peak().await;
    let collector = Arc::new(PeakCollector::default());
    let orch = orch_with(LiveSlots::default(), collector.clone());
    three_parallel(&orch).await;
    assert_eq!(collector.peak.load(Ordering::SeqCst), 3 * one);
}

#[tokio::test]
async fn vaga_espera_a_anterior_e_zero_desliga() {
    assert!(
        LiveSlots::new(0).acquire("tt0").await.is_none(),
        "0 = sem teto"
    );

    let slots = LiveSlots::new(1);
    let first = slots.acquire("tt1").await.expect("primeira vaga");
    assert_eq!(slots.in_use(), 1);
    let waiter = {
        let slots = slots.clone();
        tokio::spawn(async move { slots.acquire("tt2").await.is_some() })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!waiter.is_finished(), "a segunda espera a vaga");
    drop(first);
    assert!(waiter.await.expect("task"), "solta a vaga, a fila anda");
    assert_eq!(slots.in_use(), 0);
}
