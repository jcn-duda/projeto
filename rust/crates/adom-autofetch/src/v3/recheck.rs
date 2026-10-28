//! Transições puras de recheck. Rede, timers e persistência pertencem ao worker.

use adom_core::{expired_removal_allowed, ExpiredFacts};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecheckAction {
    Ready,
    Pending,
    Unknown,
    TerminalDead,
    TerminalStalled,
    TerminalProgress,
    RemoveExpired,
    SuppressExpired,
    ReleaseExpired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecheckInput {
    pub cached: bool,
    pub status_ok: bool,
    pub state: Option<String>,
    pub stalled: bool,
    pub derived_stalled: bool,
    pub dead_streak: i64,
    pub stall_streak: i64,
    pub dead_threshold: i64,
    pub stall_threshold: i64,
    pub expired: bool,
    pub expired_facts: ExpiredFacts,
    pub remove_supported: bool,
    pub remove_by_id_allowed: bool,
    pub id_present: bool,
}

/// Aplica a precedência do recheck: cache/pronto, morte/parada e, por fim,
/// expiração com prova de posse. Um status desconhecido nunca é prova de morte.
pub fn recheck_step(input: &RecheckInput) -> RecheckAction {
    if input.cached || input.state.as_deref() == Some("ready") {
        return RecheckAction::Ready;
    }
    if input.state.as_deref() == Some("dead") {
        return if input.dead_streak.saturating_add(1) >= input.dead_threshold.max(1) {
            RecheckAction::TerminalDead
        } else {
            RecheckAction::Pending
        };
    }
    if input.stalled && input.stall_threshold > 0 {
        return if input.stall_streak.saturating_add(1) >= input.stall_threshold.max(1) {
            RecheckAction::TerminalStalled
        } else {
            RecheckAction::Pending
        };
    }
    if input.derived_stalled {
        return RecheckAction::TerminalProgress;
    }
    if input.expired {
        if !input.remove_supported || !input.id_present {
            return RecheckAction::ReleaseExpired;
        }
        if input.remove_by_id_allowed && expired_removal_allowed(&input.expired_facts) {
            return RecheckAction::RemoveExpired;
        }
        return RecheckAction::SuppressExpired;
    }
    if !input.status_ok || input.state.is_none() {
        return RecheckAction::Unknown;
    }
    RecheckAction::Pending
}

#[cfg(test)]
#[path = "recheck_tests.rs"]
mod tests;
