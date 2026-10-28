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
    /// O status desse hash veio por id (`via === 'id'`), não por hash.
    pub via_id: bool,
    /// Knob `removeById`: só ele libera remover um torrent achado por id.
    pub remove_by_id_enabled: bool,
    pub id_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecheckStreaks {
    pub dead: i64,
    pub stalled: i64,
}

/// Atualiza contadores como a passagem do Node: morte e stall nativo têm
/// contadores independentes; falta de resposta mantém ambos. Um estado
/// observado sem sinal de morte/parada zera ambos, inclusive `unknown`
/// explícito do adaptador. Progresso derivado terminal limpa o lote fora daqui.
pub fn recheck_streaks(input: &RecheckInput) -> RecheckStreaks {
    let mut streaks = RecheckStreaks {
        dead: input.dead_streak,
        stalled: input.stall_streak,
    };
    if input.cached || input.state.as_deref() == Some("ready") {
        return RecheckStreaks {
            dead: 0,
            stalled: 0,
        };
    }
    if input.state.as_deref() == Some("dead") {
        streaks.dead = streaks.dead.saturating_add(1);
    } else if input.stalled && input.stall_threshold > 0 {
        streaks.stalled = streaks.stalled.saturating_add(1);
    } else if !input.derived_stalled && input.status_ok && input.state.is_some() {
        streaks = RecheckStreaks {
            dead: 0,
            stalled: 0,
        };
    }
    streaks
}

/// Aplica a precedência do recheck: cache/pronto, morte/parada e, por fim,
/// expiração com prova de posse. Um status desconhecido nunca é prova de morte.
pub fn recheck_step(input: &RecheckInput) -> RecheckAction {
    if input.cached || input.state.as_deref() == Some("ready") {
        return RecheckAction::Ready;
    }
    let dead = input.state.as_deref() == Some("dead");
    let native_stalled = !dead && input.stalled && input.stall_threshold > 0;
    if dead && input.dead_streak.saturating_add(1) >= input.dead_threshold.max(1) {
        return RecheckAction::TerminalDead;
    }
    if native_stalled && input.stall_streak.saturating_add(1) >= input.stall_threshold {
        return RecheckAction::TerminalStalled;
    }
    if !dead && !native_stalled && input.derived_stalled {
        return RecheckAction::TerminalProgress;
    }
    if input.expired {
        if !input.remove_supported || !input.id_present {
            return RecheckAction::ReleaseExpired;
        }
        // `policyOk` do TS: achado por hash remove sempre; por id, só com o knob.
        let policy_ok = !input.via_id || input.remove_by_id_enabled;
        if policy_ok && expired_removal_allowed(&input.expired_facts) {
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
