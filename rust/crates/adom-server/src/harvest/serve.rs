//! Loop do colhedor: pausa → budget → tick → persistência → espera.
//!
//! Roda no runtime `current_thread` da thread `adom-harvest`. O `Notify` é
//! usado por pausa, enqueue e pelo drain pedido pela rota; o intervalo é o
//! mesmo `HARVEST_INTERVAL_MS` do Node.
//!
//! O lock da fila fica curtíssimo: escolha (`begin`) e fechamento (`finish` +
//! desfecho). O `drain_one` e toda a rede rodam sem ele. A foto de evidência
//! é lida FORA do lock da fila; o comparador só vê memória.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use adom_harvest::{
    reason_priority, save_hour, DrainOutcome, HarvestDrainAsync, HarvestEntry, HarvestQueueConfig,
    HarvestWorker, PendingIntent, TickStart,
};
use adom_search::orchestrator::Orchestrator;
use adom_store::StreamsStore;

use super::drain::NetworkDrain;
use super::evidence::order_and_publish;
use super::settle::{Settlement, Settler};
use super::Inner;

/// Uma passagem do for-loop: skip, preempção ou um drain fechado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IterationOutcome {
    Skipped,
    /// O drain em voo foi dropado por uma obra de rank maior: a entrada volta
    /// à cabeça e o ciclo do budget continua.
    Preempted,
    Drained {
        ok: bool,
    },
}

/// Contabilidade extra do drain REAL; o fake do loop devolve o que declarou.
pub(crate) trait DrainFound {
    /// Evidência BR viável da última obra.
    fn take_found(&mut self) -> bool {
        false
    }

    /// Consultas já gastas na obra corrente — lidas só quando o future é
    /// dropado no meio (preempção).
    fn take_spent(&mut self) -> u32 {
        0
    }
}

impl DrainFound for NetworkDrain {
    fn take_found(&mut self) -> bool {
        NetworkDrain::take_found(self)
    }

    fn take_spent(&mut self) -> u32 {
        NetworkDrain::take_spent(self)
    }
}

pub(super) async fn serve(
    inner: Arc<Inner>,
    mut worker: HarvestWorker,
    orch: Orchestrator,
    streams: Option<Arc<StreamsStore>>,
) {
    let mut drain = NetworkDrain::new(&orch, &inner.config(), streams);
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
            match run_iteration(&inner, &mut worker, &mut drain, &mut settler, now).await {
                IterationOutcome::Skipped => break,
                // Preempção consome o tick como um drain: a obra trocou, o
                // budget segue (é o próximo ciclo quem colhe a fila atual).
                IterationOutcome::Preempted => drained = drained.saturating_add(1),
                IterationOutcome::Drained { ok } => {
                    drained += 1;
                    if !ok {
                        // Falha também interrompe o budget: insistir na mesma
                        // obra com a fonte fora martela o Jackett.
                        break;
                    }
                }
            }
        }
        persist_hour(&inner, &mut worker, adom_sources::now_ms());
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

/// Uma iteração do ciclo de produção: begin → drain sem lock → finish →
/// settle → persistir. Extraída para o teste injetar um drain com barreira;
/// o runtime (`current_thread`, notify/sleep, budget) não muda.
pub(crate) async fn run_iteration<D>(
    inner: &Inner,
    worker: &mut HarvestWorker,
    drain: &mut D,
    settler: &mut Settler,
    now: i64,
) -> IterationOutcome
where
    D: HarvestDrainAsync + DrainFound,
{
    let snapshot = inner.refresh_snapshot(now).await;
    let (entry, identity, queries_left) = {
        let mut queue = inner.queue.lock().await;
        queue.prioritize(&snapshot, now);
        match worker.begin(&mut queue, &inner.traffic, now) {
            TickStart::Skip(_) => {
                inner.publish(&queue, worker, now);
                // Skip nunca vira trabalho no mesmo ciclo.
                return IterationOutcome::Skipped;
            }
            TickStart::Run {
                entry,
                identity,
                queries_left,
            } => {
                // Com o lock da fila: o enqueue lê este rank para decidir a
                // preempção e não pode ver slot aberto sem rank.
                inner.set_inflight_rank(Some(reason_priority(&entry.reason)));
                (entry, identity, queries_left)
            }
        }
    };
    // Sem lock: a rede do drain não bloqueia a ponte Node. Uma obra de rank
    // maior enfileirada agora derruba o future — a entrada interrompida volta
    // à cabeça em vez de segurar a fila até o último indexer.
    let finished = tokio::select! {
        outcome = drain.drain_one(&entry, queries_left) => Some(outcome),
        _ = inner.preempt.notified() => None,
    };
    let Some(outcome) = finished else {
        return finish_preempted(inner, worker, drain, settler, entry, identity, now).await;
    };
    let br_found = drain.take_found();
    let mut queue = inner.queue.lock().await;
    // Snapshot ANTES do finish: o slot some no end, e a FULL remanescente
    // precisa do que coalesceu em voo.
    let settlement = Settlement {
        intent: queue.inflight().pending(&identity),
        ok: outcome.ok,
        br_found,
    };
    worker.finish(&mut queue, &identity, outcome, now);
    inner.set_inflight_rank(None);
    {
        let mut status = inner.status.lock().unwrap_or_else(|err| err.into_inner());
        status.note_drain(&entry, outcome, now, inner.config().queue_preview);
    }
    settler.settle(&mut queue, &inner.store, entry, settlement, now);
    inner.persist_queue(&queue, now);
    drop(queue);
    // Índice pode ter mudado na escrita: nova foto, depois reordenar a
    // fila ATUAL. Sem SQLite com o lock da fila.
    let after = inner.refresh_snapshot(now).await;
    {
        let mut queue = inner.queue.lock().await;
        order_and_publish(inner, &mut queue, worker, &after, now);
        inner.persist_queue(&queue, now);
    }
    IterationOutcome::Drained { ok: outcome.ok }
}

/// Preempção: o drain foi dropado no meio. A obra volta à CABEÇA com a
/// intenção que o slot acumulou (`resumed: true`), o lease da sonda renova e só
/// as consultas JÁ GASTAS são debitadas. Não é falha — a obra não saiu da fila,
/// então o desfecho de falha ([`Settler::settle`]) não roda.
async fn finish_preempted<D>(
    inner: &Inner,
    worker: &mut HarvestWorker,
    drain: &mut D,
    settler: &Settler,
    entry: HarvestEntry,
    identity: String,
    now: i64,
) -> IterationOutcome
where
    D: DrainFound,
{
    let spent = drain.take_spent();
    let mut queue = inner.queue.lock().await;
    // Snapshot do slot ANTES do finish: é a intenção efetiva da execução (o
    // que coalesceu em voo), e o `end` do finish apaga o slot.
    let intent = queue.inflight().pending(&identity);
    let resumed = resumed_entry(&entry, intent.as_ref());
    settler.note_preempted(&inner.store, &resumed, now);
    queue.head(resumed);
    // `finish` só debita `queries` e fecha o slot: `ok` não é lido aqui.
    worker.finish(
        &mut queue,
        &identity,
        DrainOutcome {
            ok: false,
            queries: spent,
        },
        now,
    );
    inner.set_inflight_rank(None);
    inner.persist_queue(&queue, now);
    inner.publish(&queue, worker, now);
    drop(queue);
    eprintln!("[harvest] preempção: {identity} volta à cabeça ({spent} consulta(s) gasta(s))");
    IterationOutcome::Preempted
}

/// Entrada devolvida pela preempção: a intenção efetiva do slot (motivo, sonda,
/// FULL pendente) sobre a original, marcada `resumed`. `enqueued_at` é o
/// ORIGINAL — preempção não inventa anti-fome.
fn resumed_entry(entry: &HarvestEntry, intent: Option<&PendingIntent>) -> HarvestEntry {
    let reason = intent
        .map(|intent| intent.reason.clone())
        .unwrap_or_else(|| entry.reason.clone());
    let br_probe = entry.br_probe || intent.is_some_and(|intent| intent.br_probe);
    let full = intent
        .and_then(|intent| intent.full.clone())
        .or_else(|| entry.pending_full());
    let full_intent = br_probe.then_some(full).flatten();
    HarvestEntry {
        imdb_id: entry.imdb_id.clone(),
        media_type: entry.media_type,
        season: entry.season,
        episode: entry.episode,
        enqueued_at: entry.enqueued_at,
        priority_at: (reason == "br-gap")
            .then(|| {
                intent
                    .and_then(|intent| intent.priority_at)
                    .or(entry.priority_at)
            })
            .flatten(),
        reason,
        resumed: true,
        br_probe,
        full_base: full_intent.is_some(),
        full_intent,
    }
}

pub(crate) fn persist_hour(inner: &Inner, worker: &mut HarvestWorker, now: i64) {
    let count = worker.queries_this_hour(now);
    if count > 0 {
        if let Err(err) = save_hour(&inner.store, count, now) {
            eprintln!("[harvest] balde horário não persistiu: {err}");
        }
    }
}

/// Leva a config do painel às peças que o loop possui (worker, fila, drain).
/// A pausa e a janela de tráfego já valeram no `apply_live`. Reordena com a
/// última foto — sem nova leitura do índice.
async fn apply_live_to_loop(inner: &Inner, worker: &mut HarvestWorker, drain: &mut NetworkDrain) {
    let config = inner.config();
    worker.set_enabled(config.enabled);
    worker.set_max_per_hour(config.max_per_hour);
    drain.set_indexer_delay(config.indexer_delay_ms);
    let snap = inner.snapshot();
    let mut queue = inner.queue.lock().await;
    queue.set_config(HarvestQueueConfig {
        enabled: config.enabled,
        queue_max: config.queue_max,
        br_first: config.br_first,
        br_max_wait_ms: config.br_max_wait_ms,
    });
    let now = adom_sources::now_ms();
    order_and_publish(inner, &mut queue, worker, &snap, now);
    eprintln!(
        "[harvest] config do painel aplicada: ligado={} teto={}/h intervalo={}ms",
        config.enabled, config.max_per_hour, config.interval_ms
    );
}

#[cfg(test)]
#[path = "loop_tests.rs"]
mod loop_tests;
