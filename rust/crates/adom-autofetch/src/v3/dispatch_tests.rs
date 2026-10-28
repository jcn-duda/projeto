use adom_core::{EnqueueGates, RollbackAction, SkipReason};

use super::{dispatch, DispatchDecision, DispatchInput};

#[test]
fn caminho_feliz_preserva_hash_e_despacha() {
    let result = dispatch(DispatchInput {
        info_hash: "AaBb".into(),
        gates: EnqueueGates::default(),
    });
    assert_eq!(
        result,
        DispatchDecision::Enqueue {
            info_hash: "AaBb".into()
        }
    );
}

#[test]
fn primeiro_gate_fecha_e_retorna_rollback_do_core() {
    let gates = EnqueueGates {
        is_paused: true,
        is_dead: true,
        ..EnqueueGates::default()
    };
    let result = dispatch(DispatchInput {
        info_hash: "dead".into(),
        gates,
    });
    assert_eq!(
        result,
        DispatchDecision::Skip {
            info_hash: "dead".into(),
            reason: SkipReason::Paused,
            rollback: vec![RollbackAction::Hold],
        }
    );
}

#[test]
fn reserva_de_obra_e_liberada_em_gate_de_conta() {
    let result = dispatch(DispatchInput {
        info_hash: "hash".into(),
        gates: EnqueueGates {
            obra_cap_granted: true,
            account_blocked: true,
            ..EnqueueGates::default()
        },
    });
    assert_eq!(
        result,
        DispatchDecision::Skip {
            info_hash: "hash".into(),
            reason: SkipReason::AccountGate,
            rollback: vec![
                RollbackAction::Obra,
                RollbackAction::Lock,
                RollbackAction::Slot,
                RollbackAction::Hold,
            ],
        }
    );
}
