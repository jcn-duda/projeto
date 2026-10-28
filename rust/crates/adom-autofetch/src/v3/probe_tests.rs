use super::{
    probe_blocks_seeds, probe_state, probe_step, ProbeDecision, ProbeInput, ProbeRecord, ProbeSkip,
    ProbeState, PROBE_PENDING_LEASE_MS, PROBE_RETRY_MS,
};

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

fn step(record: Option<ProbeRecord>, now_ms: i64) -> ProbeDecision {
    probe_step(ProbeInput {
        enabled: true,
        record,
        now_ms,
    })
}

#[test]
fn sem_registro_agenda_e_desligado_pula() {
    assert_eq!(step(None, 1_000), ProbeDecision::Schedule { orphan: false });
    assert_eq!(
        probe_step(ProbeInput {
            enabled: false,
            record: Some(ProbeRecord::pending(1_000)),
            now_ms: 1_000,
        }),
        ProbeDecision::Skip(ProbeSkip::Disabled)
    );
}

#[test]
fn pending_com_lease_vivo_pula_e_orfao_reagenda() {
    let record = ProbeRecord::pending(1_000);
    assert_eq!(
        step(Some(record), 1_000),
        ProbeDecision::Skip(ProbeSkip::Pending)
    );
    // Um tique antes de vencer ainda é sonda ativa.
    assert_eq!(
        step(Some(record), 1_000 + PROBE_PENDING_LEASE_MS - 1),
        ProbeDecision::Skip(ProbeSkip::Pending)
    );
    // Lease vencido = órfão de crash/restart: reagenda sem esperar retry.
    assert_eq!(
        step(Some(record), 1_000 + PROBE_PENDING_LEASE_MS),
        ProbeDecision::Schedule { orphan: true }
    );
}

#[test]
fn found_e_empty_deduplicam_sem_bloquear_seeds() {
    assert_eq!(
        step(Some(ProbeRecord::new(ProbeState::Found, 1_000)), 1_001),
        ProbeDecision::Skip(ProbeSkip::Found)
    );
    assert_eq!(
        step(Some(ProbeRecord::new(ProbeState::Empty, 1_000)), 1_001),
        ProbeDecision::Skip(ProbeSkip::Empty)
    );
    assert!(!probe_blocks_seeds(Some(ProbeState::Empty), 0, 1_001));
}

#[test]
fn failed_e_capped_respeitam_o_retry_curto() {
    for state in [ProbeState::Failed, ProbeState::Capped] {
        let record = ProbeRecord::new(state, 1_000);
        assert_eq!(
            step(Some(record), 1_000 + PROBE_RETRY_MS - 1),
            ProbeDecision::Skip(ProbeSkip::Retry)
        );
        assert_eq!(
            step(Some(record), 1_000 + PROBE_RETRY_MS),
            ProbeDecision::Schedule { orphan: false }
        );
        // Nenhum dos dois bloqueia seeds: a fila de sementes segue.
        assert!(!probe_blocks_seeds(Some(state), 0, 1_000));
    }
}

#[test]
fn leitura_do_painel_promove_orfao_a_failed() {
    let record = ProbeRecord::pending(0);
    assert_eq!(
        record.effective_state(PROBE_PENDING_LEASE_MS - 1),
        ProbeState::Pending
    );
    assert_eq!(
        record.effective_state(PROBE_PENDING_LEASE_MS),
        ProbeState::Failed
    );
    assert_eq!(ProbeState::parse("capped"), Some(ProbeState::Capped));
    assert_eq!(ProbeState::Capped.as_str(), "capped");
    assert_eq!(ProbeState::parse("off"), None);
}
