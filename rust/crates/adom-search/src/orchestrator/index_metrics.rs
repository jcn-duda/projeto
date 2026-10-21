//! Contadores próprios do índice/banco nativos (F4.5).
//!
//! Nada aqui depende do Node: `index.rust.*` mede a leitura/escrita nativa e o
//! funil de cobertura.
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
/// `idx:v14`/`magnets.db` sem store injetado: degradação SEM índice/banco
/// (não existe mais caminho Node).
pub const SOURCE_MISSING: &str = "index.rust.source_missing";

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
