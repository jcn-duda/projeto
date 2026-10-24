//! Métricas `debrid.al.cleanup.*` da limpeza da AllDebrid.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

pub const METRIC_PLANNED: &str = "debrid.al.cleanup.planned";
pub const METRIC_PROTECTED: &str = "debrid.al.cleanup.protected";
pub const METRIC_KNOWN_BEFORE: &str = "debrid.al.cleanup.known_before";
pub const METRIC_SUPPRESSED: &str = "debrid.al.cleanup.suppressed";
pub const METRIC_REMOVED: &str = "debrid.al.cleanup.removed";
pub const METRIC_FAILED: &str = "debrid.al.cleanup.failed";
pub const METRIC_STOPPED: &str = "debrid.al.cleanup.stopped";

fn counters() -> &'static Mutex<BTreeMap<String, u64>> {
    static COUNTERS: OnceLock<Mutex<BTreeMap<String, u64>>> = OnceLock::new();
    COUNTERS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

pub fn bump(key: &str, by: u64) {
    if by == 0 {
        return;
    }
    let mut guard = counters().lock().unwrap_or_else(|err| err.into_inner());
    *guard.entry(key.to_string()).or_insert(0) += by;
}

/// Snapshot para o `/metrics` do gateway e da API interna.
pub fn metrics_snapshot() -> BTreeMap<String, u64> {
    counters()
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
}
