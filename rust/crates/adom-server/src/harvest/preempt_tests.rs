//! Preempção intradrain (T1-A2): obra de rank maior enfileirada DURANTE o
//! drain dropa o future e devolve a obra interrompida à CABEÇA com `resumed`.
//!
//! Módulo filho de `loop_tests`: herda a barreira, o worker e a `Inner` de
//! teste sem duplicar fixture (e o arquivo do loop segue no teto de linhas).

use std::time::Duration;

use super::*;
use crate::harvest::enqueue::PreemptSignal;

/// Mesmo sinal que o `HarvestHandle::enqueue` monta, com o lock na mão.
fn signal(inner: &Inner) -> PreemptSignal<'_> {
    PreemptSignal {
        notify: &inner.preempt,
        inflight_rank: inner.current_inflight_rank(),
    }
}

#[tokio::test]
async fn preempcao_interrompe_o_drain_e_devolve_a_entrada_a_cabeca() {
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
    // A barreira NUNCA é solta: só a preempção encerra a iteração.
    let (_release_tx, release_rx) = oneshot::channel();
    let mut drain = BarrierDrain {
        entered: Some(entered_tx),
        release: Some(release_rx),
        queries: 3,
        ok: true,
        // Duas consultas já foram para o Jackett antes da barreira.
        spent: 2,
    };
    let loop_inner = inner.clone();
    let task = tokio::spawn(async move {
        let mut worker = worker();
        let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
        let outcome = run_iteration(&loop_inner, &mut worker, &mut drain, &mut settler, NOW).await;
        (outcome, worker)
    });
    entered_rx.await.expect("drain entrou");
    {
        // Obra de rank maior (next-episode = 2) contra a obra em voo (miss = 0):
        // o próprio enqueue avisa a preempção.
        let mut queue = inner.queue.lock().await;
        let urgent = enqueue_with_dedupe(
            &mut queue,
            &store,
            HarvestRequest::movie(PADRINO, "next-episode"),
            NOW,
            None,
            Some(signal(&inner)),
        );
        assert_eq!(urgent.reason, EnqueueReason::Queued);
    }
    let joined = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("preempção encerra a iteração sem soltar a barreira");
    let (outcome, mut worker) = joined.expect("iteração");
    assert_eq!(outcome, IterationOutcome::Preempted);
    assert!(!worker.in_flight(), "o slot em voo fecha na preempção");
    // Só as consultas JÁ GASTAS são debitadas; o resto da obra não aconteceu.
    assert_eq!(worker.queries_this_hour(NOW), 2);
    assert_eq!(inner.current_inflight_rank(), None);
    {
        let queue = inner.queue.lock().await;
        let head = queue.entries().first().expect("cabeça");
        assert_eq!(head.imdb_id, SHAW, "a obra interrompida volta à cabeça");
        assert!(
            head.resumed,
            "a cabeça da preempção vai marcada como resumed"
        );
        assert_eq!(head.reason, "miss", "motivo original preservado");
        assert!(queue.inflight().pending(&format!("{SHAW}::")).is_none());
        let urgent = queue.find_queued(PADRINO, None, None).expect("urgente");
        assert!(!urgent.resumed, "preempção não marca a obra que chegou");
    }
    // Próximo ciclo: a urgência sai primeiro e a obra preemptada continua na
    // fila — o `resumed` não furou a prioridade.
    let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
    let mut next = ImmediateDrain {
        ok: true,
        queries: 1,
    };
    assert_eq!(
        run_iteration(&inner, &mut worker, &mut next, &mut settler, NOW).await,
        IterationOutcome::Drained { ok: true }
    );
    let queue = inner.queue.lock().await;
    assert!(
        queue.find_queued(PADRINO, None, None).is_none(),
        "rank maior é atendido antes da obra devolvida"
    );
    let back = queue.find_queued(SHAW, None, None).expect("obra devolvida");
    assert!(back.resumed);
}

#[tokio::test]
async fn obra_de_rank_menor_nao_preempta_o_drain_em_voo() {
    let store = Arc::new(HarvestStore::open_memory().unwrap());
    let inner = test_inner(store.clone(), 86_400);
    {
        // Em voo: next-episode (rank 2).
        let mut queue = inner.queue.lock().await;
        assert!(
            enqueue_with_dedupe(
                &mut queue,
                &store,
                HarvestRequest::movie(PADRINO, "next-episode"),
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
        queries: 2,
        ok: true,
        spent: 0,
    };
    let loop_inner = inner.clone();
    let task = tokio::spawn(async move {
        let mut worker = worker();
        let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
        let outcome = run_iteration(&loop_inner, &mut worker, &mut drain, &mut settler, NOW).await;
        (outcome, worker)
    });
    entered_rx.await.expect("drain entrou");
    {
        // miss (rank 0) NÃO derruba a obra em voo: o aviso só vale para rank
        // maior, senão toda obra nova custaria um drain pela metade.
        let mut queue = inner.queue.lock().await;
        let lower = enqueue_with_dedupe(
            &mut queue,
            &store,
            HarvestRequest::movie(SHAW, "miss"),
            NOW,
            None,
            Some(signal(&inner)),
        );
        assert_eq!(lower.reason, EnqueueReason::Queued);
    }
    let _ = release_tx.send(());
    let (outcome, mut worker) = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("sem preempção a iteração termina normalmente")
        .expect("iteração");
    assert_eq!(outcome, IterationOutcome::Drained { ok: true });
    assert!(!worker.in_flight(), "o slot fecha no desfecho normal");
    assert_eq!(worker.queries_this_hour(NOW), 2, "só o drain rodou");
    let queue = inner.queue.lock().await;
    let waiting = queue.find_queued(SHAW, None, None).expect("obra nova");
    assert!(!waiting.resumed, "quem chegou não volta marcada");
}
