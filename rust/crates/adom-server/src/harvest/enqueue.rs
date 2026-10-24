//! Enqueue com o dedupe de 12 h do Node (`harvest:v1:seen:*`).
//!
//! A ordem é a do TS (`harvest-queue.ts` no `enqueue` + `seen.ts` no
//! `markRecentlyQueued`): duplicata/promoção (a fila decide) → coalescing →
//! dedupe → push. O dedupe SÓ é gravado quando a fila aceitou, para um pedido
//! inválido/duplicado não bloquear a obra por 12 h.

use adom_harvest::{
    entry_identity, mark_recently_queued, was_recently_queued, BrEvidence, EnqueueOutcome,
    EnqueueReason, HarvestEntry, HarvestQueue, HarvestRequest, HarvestStore,
};

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
) -> EnqueueOutcome {
    let probe = probe_entry(&req, now);
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
    outcome
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
