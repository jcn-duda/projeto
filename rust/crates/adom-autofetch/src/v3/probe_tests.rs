use super::{probe_blocks_seeds, probe_state, ProbeState};

#[test]
fn somente_pending_com_lease_bloqueia_seeds() {
    assert!(probe_blocks_seeds(Some(ProbeState::Pending), 101, 100));
    assert!(!probe_blocks_seeds(Some(ProbeState::Pending), 100, 100));
    assert_eq!(
        probe_state(Some(ProbeState::Pending), 100, 100),
        Some(ProbeState::Failed)
    );
    assert!(!probe_blocks_seeds(Some(ProbeState::Found), 200, 100));
    assert!(!probe_blocks_seeds(None, 0, 100));
}
