//! Enqueue com o dedupe de 12 h do Node (`harvest:v1:seen:*`).
//!
//! A ordem é a do TS (`harvest-queue.ts` no `enqueue` + `seen.ts` no
//! `markRecentlyQueued`): duplicata/promoção (a fila decide) → coalescing →
//! dedupe → push. O dedupe SÓ é gravado quando a fila aceitou, para um pedido
//! inválido/duplicado não bloquear a obra por 12 h.
//!
//! Avisa o drain em voo ([`PreemptSignal`]) quando a obra nova tem rank maior:
//! a fila não espera o último indexer da obra anterior para atender uma
//! urgência.

use adom_harvest::{
    entry_identity, mark_recently_queued, reason_priority, was_recently_queued, BrEvidence,
    EnqueueOutcome, EnqueueReason, HarvestEntry, HarvestQueue, HarvestRequest, HarvestStore,
};
use tokio::sync::Notify;

/// Sinal de preempção entregue ao enqueue pelo gateway.
///
/// `None` = sem loop do colhedor do outro lado (testes, ponte sem drain):
/// ninguém é acordado e o comportamento é o de antes da preempção.
#[derive(Clone, Copy)]
pub(crate) struct PreemptSignal<'a> {
    /// [`crate::harvest::Inner::preempt`].
    pub(crate) notify: &'a Notify,
    /// Rank do motivo da obra em voo; `None` = nenhum drain aberto.
    pub(crate) inflight_rank: Option<u8>,
}

impl PreemptSignal<'_> {
    /// A entrada nova é mais urgente que a obra em voo?
    fn outranks(self, rank: u8) -> bool {
        self.inflight_rank.is_some_and(|current| rank > current)
    }
}

/// Enqueue com o dedupe 12 h do TS, na ordem do Node.
///
/// Uma obra já na fila (ou em voo) não consulta o dedupe: o pedido precisa
/// chegar na fila para virar `duplicate`/`promoted`/`coalesced` — é o que
/// permite a promoção de motivo mesmo dentro da janela de 12 h.
pub(crate) fn enqueue_with_dedupe(
    queue: &mut HarvestQueue,
    store: &HarvestStore,
    req: HarvestRequest,
    now: i64,
    evidence: Option<&dyn BrEvidence>,
    preempt: Option<PreemptSignal<'_>>,
) -> EnqueueOutcome {
    let probe = probe_entry(&req, now);
    let rank = reason_priority(&probe.reason);
    let identity = entry_identity(&probe);
    let already_known = queue
        .entries()
        .iter()
        .any(|entry| entry_identity(entry) == identity)
        || queue.inflight().is_inflight(&identity);
    if !already_known {
        match was_recently_queued(store, &probe, now) {
            Ok(true) => return EnqueueOutcome::rejected(EnqueueReason::Dedupe),
            Ok(false) => {}
            Err(err) => eprintln!("[harvest] dedupe indisponível: {err}"),
        }
    }
    let outcome = queue.enqueue_with_evidence(req, evidence);
    if outcome.accepted {
        if let Err(err) = mark_recently_queued(store, &probe, now) {
            eprintln!("[harvest] dedupe não gravou: {err}");
        }
    }
    notify_preempt(queue, preempt, outcome, &identity, rank);
    outcome
}

/// Acorda o loop para preemptar o drain em voo.
///
/// Só vale para obra NOVA de rank maior: a MESMA obra em voo já coalesceu (o
/// drain corrente a cobre) e duplicata/promoção já está na fila.
fn notify_preempt(
    queue: &HarvestQueue,
    signal: Option<PreemptSignal<'_>>,
    outcome: EnqueueOutcome,
    identity: &str,
    rank: u8,
) {
    let Some(signal) = signal else { return };
    if !outcome.accepted || queue.inflight().is_inflight(identity) || !signal.outranks(rank) {
        return;
    }
    signal.notify.notify_one();
}

/// Entrada-sonda só para identidade/dedupe (o `enqueue` monta a definitiva).
fn probe_entry(req: &HarvestRequest, now: i64) -> HarvestEntry {
    HarvestEntry {
        imdb_id: req.imdb_id.clone(),
        media_type: req.media_type,
        season: req.season,
        episode: req.episode,
        reason: req.reason.clone(),
        enqueued_at: now,
        priority_at: (req.reason == "br-gap").then_some(now),
        resumed: false,
        br_probe: req.br_probe,
        full_base: false,
        full_intent: None,
    }
}
