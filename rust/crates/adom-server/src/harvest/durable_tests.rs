//! Claim durável da obra em voo (T1-B1).
//!
//! O bug real: `take_head` tira a entrada da memória e o drain roda SEM o lock
//! da fila; o `HarvestHandle::enqueue` do Node persiste a fila nesse meio-tempo.
//! Sem o claim no mesmo documento, essa escrita apagava a obra em voo do L2 e
//! um restart a perdia para sempre.
//!
//! Módulo filho de `loop_tests`: herda a barreira, o worker e a `Inner` de teste
//! sem duplicar fixture (e o arquivo do loop segue no teto de linhas).

use super::*;

#[tokio::test]
async fn enqueue_durante_o_drain_preserva_a_obra_em_voo_no_l2() {
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
                None,
                None
            )
            .accepted
        );
    }
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let mut drain = BarrierDrain {
        entered: Some(entered_tx),
        release: Some(release_rx),
        queries: 1,
        ok: true,
        spent: 0,
    };
    let loop_inner = inner.clone();
    let task = tokio::spawn(async move {
        let mut worker = worker();
        let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
        run_iteration(&loop_inner, &mut worker, &mut drain, &mut settler, NOW).await
    });
    entered_rx.await.expect("drain entrou");
    {
        // Espelho do `HarvestHandle::enqueue`: ingresso + `persist_queue`.
        let mut queue = inner.queue.lock().await;
        assert!(
            enqueue_with_dedupe(
                &mut queue,
                &store,
                HarvestRequest::movie(PADRINO, "miss"),
                NOW,
                None,
                None
            )
            .accepted
        );
        inner.persist_queue(&queue, NOW);
    }
    let persisted = store.load_queue(NOW).unwrap();
    assert_eq!(
        persisted
            .inflight
            .as_ref()
            .expect("claim durável no L2")
            .entry
            .imdb_id,
        SHAW
    );
    assert!(persisted.entries.iter().any(|e| e.imdb_id == PADRINO));

    release_tx.send(()).expect("soltar");
    assert_eq!(
        task.await.expect("iteração"),
        IterationOutcome::Drained { ok: true }
    );
    let depois = store.load_queue(NOW).unwrap();
    assert!(depois.inflight.is_none(), "o finish fecha o slot");
    assert_eq!(depois.entries.len(), 1);
    assert_eq!(depois.entries[0].imdb_id, PADRINO);
}
