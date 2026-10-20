//! Contadores próprios do índice/banco nativos (F4.5) e da sombra
//! `INDEX_RUST=shadow`/`BANK_RUST=shadow`.
//!
//! Nada aqui depende do Node: `index.rust.*` mede a leitura/escrita nativa e o
//! funil de cobertura; `index.shadow.*` mede só o par comparado. `not_sampled` é
//! o "skip quando não amostrado": não conta `compared` nem `divergence`.
//!
//! Exposto em `/metrics` do gateway por [`index_metrics_snapshot`].

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

pub const LOOKUP: &str = "index.rust.lookup";
pub const HIT: &str = "index.rust.hit";
pub const PARTIAL: &str = "index.rust.partial";
pub const MISS: &str = "index.rust.miss";
pub const GAP: &str = "index.rust.gap";
pub const SERVED: &str = "index.rust.served";
pub const RECORDED: &str = "index.rust.recorded";
pub const RECORD_FAILED: &str = "index.rust.record.failed";
pub const BANK_MARKED: &str = "index.rust.bank_marked";
pub const INSTANT: &str = "index.rust.instant";
pub const INSTANT_SKIP_DISABLED: &str = "index.rust.instant.skip.disabled";
pub const INSTANT_SKIP_NO_LIVE: &str = "index.rust.instant.skip.no_live_collection";
pub const INSTANT_SKIP_STALE: &str = "index.rust.instant.skip.stale";
pub const INSTANT_SKIP_NOT_COVERED: &str = "index.rust.instant.skip.not_covered";
pub const INSTANT_SKIP_NO_DUBBED: &str = "index.rust.instant.no_dubbed";
pub const INSTANT_SKIP_IDX_HASH: &str = "index.rust.instant.skip.idx_hash";
pub const BR_GAP: &str = "index.rust.br_gap";
pub const BR_GAP_UPGRADE: &str = "index.rust.br_gap.upgrade";
pub const BR_GAP_BANK_EVIDENCE: &str = "index.rust.br_gap.bank_evidence";
pub const BR_GAP_NO_EVIDENCE: &str = "index.rust.br_gap.no_evidence";
pub const BR_GAP_SERVED: &str = "index.rust.br_gap.served";
pub const EFFECTS: &str = "index.rust.effects";
/// `INDEX_RUST=on` sem store injetado: caiu no caminho Node (degradação).
pub const SOURCE_MISSING: &str = "index.rust.source_missing";

pub const SHADOW_COMPARED: &str = "index.shadow.compared";
pub const SHADOW_DIVERGENCE: &str = "index.shadow.divergence";
pub const SHADOW_INDEX_MISSING: &str = "index.shadow.index_missing";
pub const SHADOW_INDEX_EXTRA: &str = "index.shadow.index_extra";
pub const SHADOW_INSTANT_MISSING: &str = "index.shadow.instant_missing";
pub const SHADOW_INSTANT_EXTRA: &str = "index.shadow.instant_extra";
pub const SHADOW_ORDER: &str = "index.shadow.order";
pub const SHADOW_COVERAGE: &str = "index.shadow.coverage";
pub const SHADOW_PARTIAL: &str = "index.shadow.partial";
pub const SHADOW_INSTANT_ELIGIBLE: &str = "index.shadow.instant_eligible";
pub const SHADOW_ACCOUNT: &str = "index.shadow.account";
pub const SHADOW_EFFECTS: &str = "index.shadow.effects";
pub const SHADOW_NOT_SAMPLED: &str = "index.shadow.not_sampled";
pub const SHADOW_SKIPPED: &str = "index.shadow.skipped";
pub const SHADOW_ERROR: &str = "index.shadow.error";

pub const BANK_SHADOW_COMPARED: &str = "bank.shadow.compared";
pub const BANK_SHADOW_DIVERGENCE: &str = "bank.shadow.divergence";
pub const BANK_SHADOW_MISSING: &str = "bank.shadow.items_missing";
pub const BANK_SHADOW_EXTRA: &str = "bank.shadow.items_extra";
pub const BANK_SHADOW_NOT_SAMPLED: &str = "bank.shadow.not_sampled";
pub const BANK_SHADOW_ERROR: &str = "bank.shadow.error";

const KEYS: &[&str] = &[
    LOOKUP,
    HIT,
    PARTIAL,
    MISS,
    GAP,
    SERVED,
    RECORDED,
    RECORD_FAILED,
    BANK_MARKED,
    INSTANT,
    INSTANT_SKIP_DISABLED,
    INSTANT_SKIP_NO_LIVE,
    INSTANT_SKIP_STALE,
    INSTANT_SKIP_NOT_COVERED,
    INSTANT_SKIP_NO_DUBBED,
    INSTANT_SKIP_IDX_HASH,
    BR_GAP,
    BR_GAP_UPGRADE,
    BR_GAP_BANK_EVIDENCE,
    BR_GAP_NO_EVIDENCE,
    BR_GAP_SERVED,
    EFFECTS,
    SOURCE_MISSING,
    SHADOW_COMPARED,
    SHADOW_DIVERGENCE,
    SHADOW_INDEX_MISSING,
    SHADOW_INDEX_EXTRA,
    SHADOW_INSTANT_MISSING,
    SHADOW_INSTANT_EXTRA,
    SHADOW_ORDER,
    SHADOW_COVERAGE,
    SHADOW_PARTIAL,
    SHADOW_INSTANT_ELIGIBLE,
    SHADOW_ACCOUNT,
    SHADOW_EFFECTS,
    SHADOW_NOT_SAMPLED,
    SHADOW_SKIPPED,
    SHADOW_ERROR,
    BANK_SHADOW_COMPARED,
    BANK_SHADOW_DIVERGENCE,
    BANK_SHADOW_MISSING,
    BANK_SHADOW_EXTRA,
    BANK_SHADOW_NOT_SAMPLED,
    BANK_SHADOW_ERROR,
];

/// Contadores do índice/banco. `Clone` barato (`Arc<Mutex<..>>`).
#[derive(Clone, Default)]
pub struct IndexMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl IndexMetrics {
    pub fn new() -> Self {
        let metrics = Self::default();
        let _ = metrics.snapshot();
        metrics
    }

    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        for key in KEYS {
            guard.entry((*key).to_string()).or_insert(0);
        }
        guard.clone()
    }

    pub fn inc(&self, key: &str, by: u64) {
        if by == 0 {
            return;
        }
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.entry(key.to_string()).or_insert(0);
        *entry = (*entry).saturating_add(by);
    }

    #[cfg(test)]
    pub fn get(&self, key: &str) -> u64 {
        self.snapshot().get(key).copied().unwrap_or(0)
    }
}

static GLOBAL: OnceLock<IndexMetrics> = OnceLock::new();

pub(super) fn global_metrics() -> &'static IndexMetrics {
    GLOBAL.get_or_init(IndexMetrics::new)
}

/// Snapshot das métricas `index.*`/`bank.*` para a rota `/metrics`.
pub fn index_metrics_snapshot() -> BTreeMap<String, u64> {
    global_metrics().snapshot()
}

#[cfg(test)]
#[path = "index_metrics_tests.rs"]
mod tests;
