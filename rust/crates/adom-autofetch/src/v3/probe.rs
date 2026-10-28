//! Estado puro da sonda BR e lease que bloqueia pool seeds.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeState {
    Pending,
    Found,
    Empty,
    Capped,
    Failed,
}

/// Pending órfão vira `Failed`; só lease ativo bloqueia seeds.
pub fn probe_state(state: Option<ProbeState>, lease_until: i64, now: i64) -> Option<ProbeState> {
    match state {
        Some(ProbeState::Pending) if lease_until <= now => Some(ProbeState::Failed),
        other => other,
    }
}

pub fn probe_blocks_seeds(state: Option<ProbeState>, lease_until: i64, now: i64) -> bool {
    matches!(
        probe_state(state, lease_until, now),
        Some(ProbeState::Pending)
    )
}

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;
