//! Loop do colhedor: pausa → budget → tick → persistência → espera.
//!
//! Roda no runtime `current_thread` da thread `adom-harvest`. O `Notify` é
//! usado por pausa, enqueue e pelo drain pedido pela rota; o intervalo é o
//! mesmo `HARVEST_INTERVAL_MS` do Node.
//!
//! O lock da fila fica curtíssimo: escolha (`begin`) e fechamento (`finish` +
//! desfecho). O `drain_one` e toda a rede rodam sem ele.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use adom_harvest::{save_hour, HarvestDrainAsync, HarvestQueueConfig, HarvestWorker, TickStart};
use adom_search::orchestrator::Orchestrator;

use super::drain::NetworkDrain;
use super::settle::{Settlement, Settler};
use super::Inner;

pub(super) async fn serve(inner: Arc<Inner>, mut worker: HarvestWorker, orch: Orchestrator) {
    let mut drain = NetworkDrain::new(&orch, &inner.config());
    let mut settler = Settler::new(adom_harvest::DEFAULT_PROBE_TTL_SECONDS);
    loop {
        if inner.live_dirty.swap(false, Ordering::SeqCst) {
            apply_live_to_loop(&inner, &mut worker, &mut drain).await;
        }
        worker.set_paused(inner.paused.load(Ordering::SeqCst));
        // `0` = tick periódico (uma obra). Um pedido da rota roda o budget
        // inteiro e é o ÚNICO que responde ao oneshot: um pedido que chega no
        // meio de um tick espera o próximo ciclo em vez de tomar a resposta do
        // tick alheio.
        let budget = inner.drain_budget.swap(0, Ordering::SeqCst);
        let requested = budget > 0;
        let ticks = if requested { budget } else { 1 };
        let mut drained = 0usize;
        for _ in 0..ticks {
            let now = adom_sources::now_ms();
            let (entry, identity) = {
                let mut queue = inner.queue.lock().await;
                match worker.begin(&mut queue, &inner.traffic, now) {
                    TickStart::Skip(_) => {
                        inner.publish(&queue, &mut worker, now);
                        // Skip nunca vira trabalho no mesmo ciclo; o próximo
                        // tick é o intervalo (ou um notify).
                        break;
                    }
                    TickStart::Run { entry, identity } => (entry, identity),
                }
            };
            // Sem lock: a rede do drain não bloqueia a ponte Node.
            let outcome = drain.drain_one(&entry).await;
            let br_found = drain.take_found();
            let mut queue = inner.queue.lock().await;
            // Sonda que coalesceu em voo também finaliza: a intenção efetiva do
            // slot é lida ANTES do `finish` fechá-lo (`isProbe` do TS).
            let is_probe = entry.br_probe
                || queue
                    .inflight()
                    .pending(&identity)
                    .is_some_and(|intent| intent.br_probe);
            worker.finish(&mut queue, &identity, outcome, now);
            {
                let mut status = inner.status.lock().unwrap_or_else(|err| err.into_inner());
                status.note_drain(&entry, outcome, now, inner.config().queue_preview);
            }
            settler.settle(
                &mut queue,
                &inner.store,
                entry,
                Settlement {
                    is_probe,
                    ok: outcome.ok,
                    br_found,
                },
                now,
            );
            inner.publish(&queue, &mut worker, now);
            inner.persist_queue(&queue, now);
            drained += 1;
            if !outcome.ok {
                // Falha também interrompe o budget: insistir na mesma obra
                // com a fonte fora martela o Jackett.
                break;
            }
        }
        let count = worker.queries_this_hour(adom_sources::now_ms());
        if count > 0 {
            if let Err(err) = save_hour(&inner.store, count, adom_sources::now_ms()) {
                eprintln!("[harvest] balde horário não persistiu: {err}");
            }
        }
        if requested {
            if let Some(tx) = inner
                .drain_reply
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .take()
            {
                let _ = tx.send(drained);
            }
        }
        tokio::select! {
            _ = inner.notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_millis(inner.config().interval_ms.max(1))) => {}
        }
    }
}

/// Leva a config do painel às peças que o loop possui (worker, fila, drain).
/// A pausa e a janela de tráfego já valeram no `apply_live`.
async fn apply_live_to_loop(inner: &Inner, worker: &mut HarvestWorker, drain: &mut NetworkDrain) {
    let config = inner.config();
    worker.set_enabled(config.enabled);
    worker.set_max_per_hour(config.max_per_hour);
    drain.set_indexer_delay(config.indexer_delay_ms);
    let mut queue = inner.queue.lock().await;
    queue.set_config(HarvestQueueConfig {
        enabled: config.enabled,
        queue_max: config.queue_max,
        br_first: config.br_first,
        br_max_wait_ms: config.br_max_wait_ms,
    });
    let now = adom_sources::now_ms();
    inner.publish(&queue, worker, now);
    eprintln!(
        "[harvest] config do painel aplicada: ligado={} teto={}/h intervalo={}ms",
        config.enabled, config.max_per_hour, config.interval_ms
    );
}
