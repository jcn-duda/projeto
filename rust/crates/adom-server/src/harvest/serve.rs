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
    HarvestWorker, PendingIntent, TickStart, OUTBOX_BATCH_LIMIT,
};
use adom_search::orchestrator::Orchestrator;
use adom_store::StreamsStore;

use super::config::br_probe_ttl_seconds;
use super::drain::NetworkDrain;
use super::drain_outbox::drain_outbox;
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

    /// Run do journal aberto para a obra corrente (no-op no fake do loop).
    fn begin_run(&mut self, _run_id: &str) {}

    /// Fecha o run corrente; chamado nos dois desfechos (drain e preempção).
    fn end_run(&mut self) {}
}

impl DrainFound for NetworkDrain {
    fn take_found(&mut self) -> bool {
        NetworkDrain::take_found(self)
    }

    fn take_spent(&mut self) -> u32 {
        NetworkDrain::take_spent(self)
    }

    fn begin_run(&mut self, run_id: &str) {
        NetworkDrain::begin_run(self, run_id);
    }

    fn end_run(&mut self) {
        NetworkDrain::end_run(self);
    }
}

pub(super) async fn serve(
    inner: Arc<Inner>,
    mut worker: HarvestWorker,
    orch: Orchestrator,
    streams: Option<Arc<StreamsStore>>,
) {
    let mut drain = NetworkDrain::new(
        &orch,
        &inner.config(),
        streams.clone(),
        Some(inner.store.clone()),
    );
    // TTL do registro final vem do env (`BR_PROBE_TTL_S`), como no
    // `probe_step`/`brProbeTtl`: constante fixa aqui divergia do leitor.
    let mut settler = Settler::new(br_probe_ttl_seconds());
    loop {
        // Primeiro passo do tick, ANTES de qualquer guarda: a outbox é do
        // processo, não da obra. O drain que gravou o índice e morreu antes de
        // invalidar deixou o alvo aqui, e ele tem que sair mesmo com a fila
        // vazia, com pausa ou com teto estourado.
        drain_outbox_step(&inner, streams.as_ref());
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
    let (entry, identity, run_id, queries_left) = {
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
                run_id,
                queries_left,
            } => {
                // Com o lock da fila: o enqueue lê este rank para decidir a
                // preempção e não pode ver slot aberto sem rank.
                inner.set_inflight_rank(Some(reason_priority(&entry.reason)));
                // `claim` = escrita (T1-B1). A obra em voo viaja no MESMO
                // documento da fila: sem esta linha, o enqueue do Node — que
                // persiste durante o drain — gravaria a fila sem ela e um
                // restart a perderia para sempre.
                inner.persist_queue(&queue, now);
                (entry, identity, run_id, queries_left)
            }
        }
    };
    // Run do journal: registra o que a execução FEZ, não o que ela tentou.
    // A outbox é a garantia de propagação; o journal é a trilha auditável. O id
    // vem do MESMO claim que gravou a lease (T1-B3): é esse par que o replay de
    // boot usa para saber qual obra voltar à fila.
    if let Err(err) = inner.store.journal_begin(&run_id, &entry.imdb_id, now) {
        eprintln!("[harvest] journal: run {run_id} não abriu: {err}");
    }
    drain.begin_run(&run_id);
    // Sem lock: a rede do drain não bloqueia a ponte Node. Uma obra de rank
    // maior enfileirada agora derruba o future — a entrada interrompida volta
    // à cabeça em vez de segurar a fila até o último indexer.
    let finished = tokio::select! {
        outcome = drain.drain_one(&entry, queries_left) => Some(outcome),
        _ = inner.preempt.notified() => None,
    };
    let Some(outcome) = finished else {
        let slot = RunSlot { identity, run_id };
        return finish_preempted(inner, worker, drain, settler, entry, slot, now).await;
    };
    drain.end_run();
    // ANTES do `worker.finish`: o run fecha no journal mesmo que o processo
    // morra no fechamento do slot durável.
    let run_status = if outcome.ok { "done" } else { "failed" };
    let closed = if outcome.ok {
        inner.store.journal_finish(&run_id, run_status, now)
    } else {
        inner.store.journal_fail(&run_id, "drain_failed", now)
    };
    if let Err(err) = closed {
        eprintln!("[harvest] journal: run {run_id} não fechou: {err}");
    }
    let br_found = drain.take_found();
    let mut queue = inner.queue.lock().await;
    // Snapshot ANTES do finish: o slot some no end, e a FULL remanescente
    // precisa do que coalesceu em voo.
    let settlement = Settlement {
        intent: queue.inflight().pending(&identity),
        ok: outcome.ok,
        br_found,
        // Teto cortou alvos: a sonda finaliza `capped`, não `empty`.
        capped: outcome.truncated,
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

/// Identidade da obra + run do journal aberto para ela. Andam sempre juntos
/// (o `run_id` sai do MESMO claim que abriu a lease, em `worker.begin`), e o
/// par viaja junto para a preempção fechar o run SEM reconstruir a chave.
struct RunSlot {
    identity: String,
    run_id: String,
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
    slot: RunSlot,
    now: i64,
) -> IterationOutcome
where
    D: DrainFound,
{
    let RunSlot { identity, run_id } = slot;
    let spent = drain.take_spent();
    // Preempção não é falha da obra, mas o run não terminou: fecha com motivo
    // em vez de deixar "running" por 24 h. A obra volta à fila e abre run novo.
    drain.end_run();
    if let Err(err) = inner.store.journal_fail(&run_id, "preempted", now) {
        eprintln!("[harvest] journal: run de {identity} não fechou na preempção: {err}");
    }
    let mut queue = inner.queue.lock().await;
    // Snapshot do slot ANTES do finish: é a intenção efetiva da execução (o
    // que coalesceu em voo), e o `end` do finish apaga o slot.
    let intent = queue.inflight().pending(&identity);
    let resumed = resumed_entry(&entry, intent.as_ref());
    settler.note_preempted(&inner.store, &resumed, now);
    queue.head(resumed);
    // `finish` só debita `queries` e fecha o slot: `ok`/`truncated` não são lidos.
    let closed = DrainOutcome {
        ok: false,
        queries: spent,
        truncated: false,
    };
    worker.finish(&mut queue, &identity, closed, now);
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

/// Dreno da outbox com o relato colado no status do painel.
///
/// Roda no topo do tick, sem o lock da fila e antes de qualquer guarda: o
/// alvo pendente é do processo, não da obra. Erro do store não perde nada — o
/// `take` já gravou `tries` e a dead-letter acontece sozinha.
fn drain_outbox_step(inner: &Inner, streams: Option<&Arc<StreamsStore>>) {
    let now = adom_sources::now_ms();
    let report = drain_outbox(&inner.store, streams, OUTBOX_BATCH_LIMIT, now);
    if let Some(err) = report.store_error.as_deref() {
        eprintln!("[harvest] outbox: store falhou ({err}); alvos seguem na fila");
    }
    if report.acked > 0 || report.failed > 0 {
        eprintln!(
            "[harvest] outbox: {} propagado(s), {} pendente(s), {} morto(s)",
            report.acked, report.failed, report.dead
        );
    }
    inner
        .status
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .outbox_dead = report.dead;
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
