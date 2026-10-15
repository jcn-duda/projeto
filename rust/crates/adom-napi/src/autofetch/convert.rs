//! Conversões de fronteira: das structs NAPI (`f64`/`Option`) para os tipos
//! puros do `adom-core`. Isoladas aqui para manter o `decide` legível e cada
//! arquivo dentro do teto de linhas.

use adom_core::{EnqueueGates, ObraRecordEntry, PendingReservation, PoolStream, SeedsCandidate};

use super::types::{AutofetchStreamIn, EnqueueGatesIn, ObraRecordIn, PendingIn};

/// `f64` finito e inteiro → `i64`; o resto vira `None` (o `?? / || 0` do JS).
pub(super) fn js_i64(value: Option<f64>) -> Option<i64> {
    value.and_then(|v| {
        (v.is_finite() && v.fract() == 0.0 && (i64::MIN as f64..=i64::MAX as f64).contains(&v))
            .then_some(v as i64)
    })
}

/// `f64` → `i64` por truncamento; não-finito vira 0 (o `Math.trunc(x || 0)`).
pub(super) fn trunc(value: f64) -> i64 {
    if value.is_finite() {
        value.trunc() as i64
    } else {
        0
    }
}

pub(super) fn pool_stream_in(s: &AutofetchStreamIn) -> PoolStream {
    PoolStream {
        info_hash: s.info_hash.clone(),
        title: s.title.clone(),
        name: s.name.clone(),
        quality: s.quality.clone(),
        seeders: js_i64(s.seeders),
        is_br: s.is_br,
        is_dubbed: s.is_dubbed,
        is_dub_claim: s.is_dub_claim,
        is_bank_dub: s.is_bank_dub,
        is_lied: s.is_lied,
        from_fallback: s.from_fallback,
        fallback_fetchable: s.fallback_fetchable,
    }
}

pub(super) fn seeds_candidate_in(s: &AutofetchStreamIn) -> SeedsCandidate {
    SeedsCandidate {
        size_field: s.size_bytes,
        pack_bytes: s.pack_bytes,
        quality_underscore: s.quality.clone(),
        quality_plain: None,
        size_queue: None,
        title: s.title.clone(),
        name: s.name.clone(),
    }
}

pub(super) fn record_in(e: &ObraRecordIn) -> ObraRecordEntry {
    ObraRecordEntry {
        hash: e.hash.to_lowercase(),
        pool: e.pool.clone(),
        accepted_at: e.accepted_at,
        title: e.title.clone(),
        br: e.br,
        dubbed: e.dubbed,
        id: e.id.clone(),
        quality: e.quality.clone(),
        overflow: e.overflow,
    }
}

pub(super) fn pending_in(p: &PendingIn) -> PendingReservation {
    PendingReservation {
        id: p.id.clone(),
        pool: p.pool.clone(),
        rare: p.rare,
        at: p.at,
        hash: p.hash.to_lowercase(),
        quality: p.quality.clone(),
        overflow: p.overflow,
    }
}

pub(super) fn gates_in(g: &EnqueueGatesIn) -> EnqueueGates {
    EnqueueGates {
        is_paused: g.is_paused,
        is_dead: g.is_dead,
        is_cached: g.is_cached,
        marker_active: g.marker_active,
        lock_acquired: g.lock_acquired,
        slot_acquired: g.slot_acquired,
        obra_cap_granted: g.obra_cap_granted,
        account_blocked: g.account_blocked,
        budget_granted: g.budget_granted,
    }
}

pub(super) fn hash_of(streams: &[PoolStream], i: usize) -> String {
    streams[i]
        .info_hash
        .clone()
        .unwrap_or_default()
        .to_lowercase()
}
