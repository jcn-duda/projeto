//! Config, relógio e evidência neutra da fila.

use crate::prioritize::{BrEvidence, PrioritizeConfig};

/// Config mínima do stub (espelha fatias de `harvesterLive.effective()`).
#[derive(Debug, Clone)]
pub struct HarvestQueueConfig {
    pub enabled: bool,
    /// Teto `HARVEST_QUEUE_MAX` (default TS: 200).
    pub queue_max: usize,
    /// `HARVEST_BR_FIRST` — prioriza evidência BR no tier regular.
    pub br_first: bool,
    /// `HARVEST_BR_MAX_WAIT_MS` — anti-fome no tier regular (`0` = off).
    pub br_max_wait_ms: i64,
}

impl Default for HarvestQueueConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            queue_max: 200,
            br_first: true,
            br_max_wait_ms: 6 * 3600 * 1000,
        }
    }
}

impl HarvestQueueConfig {
    /// Fatia usada por [`crate::prioritize`].
    pub fn prioritize_config(&self) -> PrioritizeConfig {
        PrioritizeConfig {
            br_first: self.br_first,
            br_max_wait_ms: self.br_max_wait_ms,
        }
    }
}

/// Relógio injetável — testes não dependem de `SystemTime`.
pub type ClockMs = fn() -> i64;

/// Foto vazia: identidade sem evidência fica no rank neutro.
pub(crate) struct NeutralEvidence;

impl BrEvidence for NeutralEvidence {
    fn lookup(&self, _: &str, _: Option<i32>, _: Option<i32>) -> bool {
        false
    }

    fn has_br_dubbed(&self, _: &str, _: Option<i32>, _: Option<i32>) -> bool {
        false
    }
}

pub(crate) fn system_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
