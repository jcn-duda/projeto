//! Contadores `source.shadow.*` (extraídos de `source_shadow.rs` pela catraca
//! de 400 linhas). `partial_divergence` e `skipped` são informativos: NÃO
//! entram em `divergence`. `compared` conta o par comparado mesmo quando o
//! `partial` difere (a diferença fica em `partial_divergence`).

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

pub const COMPARED: &str = "source.shadow.compared";
pub const DIVERGENCE: &str = "source.shadow.divergence";
pub const ITEMS_MISSING: &str = "source.shadow.items_missing";
pub const ITEMS_EXTRA: &str = "source.shadow.items_extra";
pub const LIVE_DIVERGENCE: &str = "source.shadow.live_divergence";
pub const TIMEOUT: &str = "source.shadow.timeout";
pub const ERROR: &str = "source.shadow.error";
/// Informativa: `partial` é janela de coleta do Node, não prova de divergência
/// de fonte. NÃO soma em `divergence`; `compared` segue contando o par.
pub const PARTIAL_DIVERGENCE: &str = "source.shadow.partial_divergence";
/// Fonte da sombra não está habilitada nos `providers` efetivos: pulou.
pub const SKIPPED: &str = "source.shadow.skipped";
/// Job de varredura tardia: a sombra de fonte não roda (sem comparação).
pub const SKIPPED_LATE: &str = "source.shadow.skipped_late";

const KEYS: &[&str] = &[
    COMPARED,
    DIVERGENCE,
    ITEMS_MISSING,
    ITEMS_EXTRA,
    LIVE_DIVERGENCE,
    TIMEOUT,
    ERROR,
    PARTIAL_DIVERGENCE,
    SKIPPED,
    SKIPPED_LATE,
];

/// Contadores da sombra de fonte. `Clone` barato (`Arc<Mutex<..>>`).
#[derive(Clone, Default)]
pub struct SourceShadowMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl SourceShadowMetrics {
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

static GLOBAL: OnceLock<SourceShadowMetrics> = OnceLock::new();

pub(super) fn global_metrics() -> &'static SourceShadowMetrics {
    GLOBAL.get_or_init(SourceShadowMetrics::new)
}

/// Snapshot das métricas `source.shadow.*` para a rota `/metrics` do gateway.
pub fn source_shadow_metrics_snapshot() -> BTreeMap<String, u64> {
    global_metrics().snapshot()
}
