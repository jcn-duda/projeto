use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
use std::task::{Context, Poll, Waker};

use super::*;
use crate::hour::HOUR_MS;
use crate::queue::{HarvestQueue, HarvestQueueConfig};
use crate::types::{EnqueueReason, HarvestRequest};

const NOW: i64 = 1_700_000_000_000; // balde fixo

fn queue_with(ids: &[&str]) -> HarvestQueue {
    let mut q = HarvestQueue::with_clock(HarvestQueueConfig::default(), || NOW);
    for id in ids {
        q.enqueue(HarvestRequest::movie(*id, "miss"));
    }
    q
}

fn worker_capped(max: u32) -> HarvestWorker {
    HarvestWorker::new(HarvestWorkerConfig {
        enabled: true,
        max_per_hour: max,
    })
}

#[test]
fn tick_take_head_chama_drain() {
    let mut worker = worker_capped(120);
    let mut queue = queue_with(&["tt0111161", "tt0068646"]);
    let mut seen: Vec<String> = Vec::new();
    let mut drain = |e: &HarvestEntry| {
        seen.push(e.imdb_id.clone());
        DrainOutcome::ok_with_queries(2)
    };

    let out = worker.tick(&mut queue, &false, &mut drain, NOW);
    assert!(out.did_drain());
    match out {
        TickOutcome::Drained { entry, outcome } => {
            assert_eq!(entry.imdb_id, "tt0111161");
            assert!(outcome.ok);
            assert_eq!(outcome.queries, 2);
        }
        other => panic!("esperado Drained, got {other:?}"),
    }
    assert_eq!(seen, vec!["tt0111161"]);
    assert_eq!(queue.depth(), 1);
    assert_eq!(worker.queries_this_hour(NOW), 2);
    assert!(!worker.in_flight());
}

#[test]
fn freio_busy_skip_sem_consumir_fila() {
    let mut worker = worker_capped(120);
    let mut queue = queue_with(&["tt0111161"]);
    let calls = std::cell::Cell::new(0u32);
    let mut drain = |_e: &HarvestEntry| {
        calls.set(calls.get() + 1);
        DrainOutcome::ok_with_queries(1)
    };

    let out = worker.tick(&mut queue, &StubTraffic { busy: true }, &mut drain, NOW);
    assert_eq!(out, TickOutcome::SkippedBusy);
    assert_eq!(calls.get(), 0);
    assert_eq!(queue.depth(), 1);
    assert_eq!(worker.queries_this_hour(NOW), 0);

    // Com sonda na fila, o tráfego deixa passar SÓ ela (fora de turno).
    queue.enqueue(HarvestRequest::movie("tt0068646", "miss"));
    let mut probe = HarvestRequest::movie("tt0111161", "miss");
    probe.br_probe = true;
    queue.enqueue(probe);
    let out = worker.tick(&mut queue, &StubTraffic { busy: true }, &mut drain, NOW);
    assert!(matches!(out, TickOutcome::Drained { entry, .. } if entry.br_probe));
    assert_eq!(calls.get(), 1);
    assert_eq!(queue.depth(), 1);
    assert_eq!(queue.preview(1)[0].imdb_id, "tt0068646");
}

#[test]
fn teto_horario_bloqueia_apos_limite() {
    let mut worker = worker_capped(2);
    let mut queue = queue_with(&["tt0000001", "tt0000002"]);
    let mut drain = |_e: &HarvestEntry| DrainOutcome::ok_with_queries(2);

    let first = worker.tick(&mut queue, &false, &mut drain, NOW);
    assert!(first.did_drain());
    assert_eq!(worker.queries_this_hour(NOW), 2);

    // Guard ANTES do take_head: count >= max ⇒ skip sem consumir.
    let blocked = worker.tick(&mut queue, &false, &mut drain, NOW);
    assert_eq!(blocked, TickOutcome::SkippedHourlyCap);
    assert_eq!(queue.depth(), 1);
    assert_eq!(queue.preview(1)[0].imdb_id, "tt0000002");
}

#[test]
fn teto_reseta_na_virada_de_hora() {
    let mut worker = worker_capped(2);
    worker.note_queries(2, NOW);
    assert_eq!(worker.queries_this_hour(NOW), 2);

    let next_hour = NOW + HOUR_MS;
    assert_eq!(worker.queries_this_hour(next_hour), 0);

    let mut queue = queue_with(&["tt0111161"]);
    let mut drain = |_e: &HarvestEntry| DrainOutcome::ok_with_queries(1);
    let out = worker.tick(&mut queue, &false, &mut drain, next_hour);
    assert!(out.did_drain());
    assert_eq!(worker.queries_this_hour(next_hour), 1);
}

#[test]
fn desligado_pausado_vazio_e_inflight() {
    let mut worker = worker_capped(120);
    let mut queue = queue_with(&["tt0111161"]);
    let mut drain = |_e: &HarvestEntry| DrainOutcome::ok_with_queries(1);

    worker.set_enabled(false);
    assert_eq!(
        worker.tick(&mut queue, &false, &mut drain, NOW),
        TickOutcome::SkippedDisabled
    );
    worker.set_enabled(true);

    worker.set_paused(true);
    assert_eq!(
        worker.tick(&mut queue, &false, &mut drain, NOW),
        TickOutcome::SkippedPaused
    );
    worker.set_paused(false);

    let mut empty = HarvestQueue::with_clock(HarvestQueueConfig::default(), || NOW);
    assert_eq!(
        worker.tick(&mut empty, &false, &mut drain, NOW),
        TickOutcome::SkippedEmpty
    );

    // Flag privada: o submodule de teste acessa para cobrir o skip.
    worker.in_flight = true;
    assert_eq!(
        worker.tick(&mut queue, &false, &mut drain, NOW),
        TickOutcome::SkippedInFlight
    );
    assert_eq!(queue.depth(), 1);
}

#[test]
fn tick_encerra_o_slot_da_obra_colhida() {
    let mut queue = queue_with(&["tt0111161"]);
    let head = queue.preview(1)[0].clone();
    let identity = entry_identity(&head);
    let inflight = queue.inflight_mut();
    inflight.begin(&identity, HarvestIntent::from_entry(&head));

    let mut worker = worker_capped(120);
    let mut drain = |_e: &HarvestEntry| DrainOutcome::ok_with_queries(1);
    assert!(worker.tick(&mut queue, &false, &mut drain, NOW).did_drain());
    // O `end` do tick casa a identidade da entrada colhida.
    assert!(!queue.inflight().is_inflight(&identity));
}

// --- porta async (gateway / Jackett nativo) -------------------------------

/// Executor mínimo: sem runtime no crate, o teste conduz o future na mão.
fn block_on<F: Future>(fut: F) -> F::Output {
    let mut fut = std::pin::pin!(fut);
    let mut cx = Context::from_waker(Waker::noop());
    // Laço curto de propósito: o drain de teste cede UMA vez; futuro que não
    // acorda reprova o teste em vez de pendurar a suíte.
    for _ in 0..64 {
        if let Poll::Ready(out) = fut.as_mut().poll(&mut cx) {
            return out;
        }
    }
    panic!("future não completou em 64 polls");
}

/// Cede uma vez antes de completar — prova que o `await` do tick é dirigido.
struct YieldOnce(bool);

impl Future for YieldOnce {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            Poll::Ready(())
        } else {
            self.0 = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

/// Drain async de teste: conta chamadas (atômico, o future precisa ser `Send`).
struct AsyncDrain {
    calls: AtomicU32,
    queries: u32,
    fail: bool,
}

impl AsyncDrain {
    fn new(queries: u32) -> Self {
        Self {
            calls: AtomicU32::new(0),
            queries,
            fail: false,
        }
    }

    fn failing() -> Self {
        Self {
            fail: true,
            ..Self::new(0)
        }
    }

    fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
}

impl HarvestDrainAsync for AsyncDrain {
    fn drain_one<'a>(
        &'a mut self,
        entry: &'a HarvestEntry,
    ) -> Pin<Box<dyn Future<Output = DrainOutcome> + Send + 'a>> {
        Box::pin(async move {
            assert!(!entry.imdb_id.is_empty(), "drain async sem obra");
            YieldOnce(false).await;
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                DrainOutcome::failed()
            } else {
                DrainOutcome::ok_with_queries(self.queries)
            }
        })
    }
}

#[test]
fn tick_async_drena_e_fecha_o_slot() {
    let mut worker = worker_capped(120);
    let mut queue = queue_with(&["tt0111161", "tt0068646"]);
    let head = queue.preview(1)[0].clone();
    let identity = entry_identity(&head);
    let mut drain = AsyncDrain::new(2);

    let out = block_on(worker.tick_async(&mut queue, &false, &mut drain, NOW));
    match out {
        TickOutcome::Drained { entry, outcome } => {
            assert_eq!(entry.imdb_id, "tt0111161");
            assert!(outcome.ok);
            assert_eq!(outcome.queries, 2);
        }
        other => panic!("esperado Drained, got {other:?}"),
    }
    assert_eq!(drain.calls(), 1);
    assert_eq!(queue.depth(), 1);
    assert_eq!(queue.preview(1)[0].imdb_id, "tt0068646");
    // Mesma contabilidade do tick sync: debita e libera o slot da cabeça.
    assert_eq!(worker.queries_this_hour(NOW), 2);
    assert!(!worker.in_flight());
    assert!(!queue.inflight().is_inflight(&identity));
}

#[test]
fn tick_async_respeita_busy() {
    let mut worker = worker_capped(120);
    let mut queue = queue_with(&["tt0111161"]);
    let mut drain = AsyncDrain::new(1);

    let out = block_on(worker.tick_async(&mut queue, &StubTraffic { busy: true }, &mut drain, NOW));
    assert_eq!(out, TickOutcome::SkippedBusy);
    assert_eq!(drain.calls(), 0);
    assert_eq!(queue.depth(), 1);
    assert_eq!(worker.queries_this_hour(NOW), 0);
    assert!(!worker.in_flight());

    // Sonda na fila: passa só ela, como no tick sync. A sonda da MESMA obra
    // promove a entrada existente no lugar (não duplica).
    queue.enqueue(HarvestRequest::movie("tt0068646", "miss"));
    let mut probe = HarvestRequest::movie("tt0111161", "miss");
    probe.br_probe = true;
    queue.enqueue(probe);
    let out = block_on(worker.tick_async(&mut queue, &StubTraffic { busy: true }, &mut drain, NOW));
    assert!(matches!(out, TickOutcome::Drained { entry, .. } if entry.br_probe));
    assert_eq!(drain.calls(), 1);
    assert_eq!(queue.depth(), 1);
    assert_eq!(queue.preview(1)[0].imdb_id, "tt0068646");
}

#[test]
fn tick_async_respeita_teto_horario() {
    let mut worker = worker_capped(2);
    worker.note_queries(2, NOW);
    let mut queue = queue_with(&["tt0000002"]);
    let mut drain = AsyncDrain::new(1);

    let out = block_on(worker.tick_async(&mut queue, &false, &mut drain, NOW));
    assert_eq!(out, TickOutcome::SkippedHourlyCap);
    assert_eq!(drain.calls(), 0);
    assert_eq!(queue.depth(), 1);
    assert_eq!(queue.preview(1)[0].imdb_id, "tt0000002");

    // Virada de hora: o balde zera e a mesma cabeça passa a drenar.
    let next_hour = NOW + HOUR_MS;
    let out = block_on(worker.tick_async(&mut queue, &false, &mut drain, next_hour));
    assert!(out.did_drain());
    assert_eq!(drain.calls(), 1);
    assert_eq!(queue.depth(), 0);
    assert_eq!(worker.queries_this_hour(next_hour), 1);
}

#[test]
fn tick_async_fecha_o_slot_com_drain_falho() {
    let mut worker = worker_capped(120);
    let mut queue = queue_with(&["tt0111161"]);
    let head = queue.preview(1)[0].clone();
    let identity = entry_identity(&head);
    let mut drain = AsyncDrain::failing();

    let out = block_on(worker.tick_async(&mut queue, &false, &mut drain, NOW));
    match out {
        TickOutcome::Drained { entry, outcome } => {
            assert_eq!(entry.imdb_id, "tt0111161");
            assert!(!outcome.ok);
        }
        other => panic!("esperado Drained, got {other:?}"),
    }
    // Falha do drain não pode deixar a obra presa em voo.
    assert_eq!(drain.calls(), 1);
    assert!(!worker.in_flight());
    assert!(!queue.inflight().is_inflight(&identity));
    assert_eq!(worker.queries_this_hour(NOW), 0);
}

#[test]
fn begin_abre_o_slot_e_finish_fecha_depois_da_rede() {
    let mut worker = worker_capped(120);
    let mut queue = queue_with(&["tt0111161"]);

    // Primeira metade: a cabeça saiu e o slot já está aberto ANTES da rede.
    let TickStart::Run { entry, identity } = worker.begin(&mut queue, &false, NOW) else {
        panic!("esperado Run");
    };
    assert_eq!(entry.imdb_id, "tt0111161");
    assert_eq!(queue.depth(), 0);
    assert!(worker.in_flight());
    assert!(queue.inflight().is_inflight(&identity));

    // Enqueue da MESMA obra durante o drain coalesce: é o ganho do lock curto.
    let coalesced = queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    assert_eq!(coalesced.reason, EnqueueReason::Coalesced);

    // Segunda metade: debita as consultas e libera a obra.
    worker.finish(&mut queue, &identity, DrainOutcome::ok_with_queries(2), NOW);
    assert!(!worker.in_flight());
    assert_eq!(queue.inflight().pending(&identity), None);
    assert_eq!(worker.queries_this_hour(NOW), 2);
    assert_eq!(queue.depth(), 0);
}

#[test]
fn begin_com_skip_nao_consome_nem_abre_slot() {
    let mut worker = worker_capped(120);
    worker.set_paused(true);
    let mut queue = queue_with(&["tt0111161"]);

    match worker.begin(&mut queue, &false, NOW) {
        TickStart::Skip(TickOutcome::SkippedPaused) => {}
        other => panic!("esperado SkippedPaused, got {other:?}"),
    }
    assert_eq!(queue.depth(), 1);
    assert!(!worker.in_flight());
    assert_eq!(worker.queries_this_hour(NOW), 0);
}
