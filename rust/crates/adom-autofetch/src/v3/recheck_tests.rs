use adom_core::ExpiredFacts;

use super::{recheck_step, recheck_streaks, RecheckAction, RecheckInput, RecheckStreaks};

fn input() -> RecheckInput {
    RecheckInput {
        cached: false,
        status_ok: true,
        state: Some("downloading".into()),
        stalled: false,
        derived_stalled: false,
        dead_streak: 0,
        stall_streak: 0,
        dead_threshold: 2,
        stall_threshold: 3,
        expired: false,
        expired_facts: ExpiredFacts {
            hash_empty: false,
            is_cleanup_protected: false,
            adapter_is_alldebrid: true,
            has_marker: true,
            has_adsub: false,
            has_snapshot: true,
            in_snapshot: false,
        },
        remove_supported: true,
        remove_by_id_allowed: true,
        id_present: true,
    }
}

#[test]
fn cache_hit_e_ready_tem_precedencia() {
    assert_eq!(
        recheck_step(&RecheckInput {
            cached: true,
            state: Some("dead".into()),
            ..input()
        }),
        RecheckAction::Ready
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            state: Some("ready".into()),
            ..input()
        }),
        RecheckAction::Ready
    );
}

#[test]
fn morte_e_stall_precisam_atingir_limiar() {
    assert_eq!(
        recheck_step(&RecheckInput {
            state: Some("dead".into()),
            ..input()
        }),
        RecheckAction::Pending
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            state: Some("dead".into()),
            dead_streak: 1,
            ..input()
        }),
        RecheckAction::TerminalDead
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            stalled: true,
            stall_streak: 1,
            ..input()
        }),
        RecheckAction::Pending
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            stalled: true,
            stall_streak: 2,
            ..input()
        }),
        RecheckAction::TerminalStalled
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            stalled: true,
            stall_threshold: 0,
            ..input()
        }),
        RecheckAction::Pending
    );
}

#[test]
fn desconhecido_e_neutro_mas_expiracao_segue_o_fluxo_de_settle() {
    assert_eq!(
        recheck_step(&RecheckInput {
            status_ok: false,
            state: None,
            ..input()
        }),
        RecheckAction::Unknown
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            status_ok: false,
            state: None,
            expired: true,
            id_present: false,
            ..input()
        }),
        RecheckAction::ReleaseExpired
    );
}

#[test]
fn expirar_alldebrid_exige_posse_snapshot_e_sem_protecao() {
    assert_eq!(
        recheck_step(&RecheckInput {
            expired: true,
            ..input()
        }),
        RecheckAction::RemoveExpired
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            expired: true,
            expired_facts: ExpiredFacts {
                has_snapshot: false,
                ..input().expired_facts
            },
            ..input()
        }),
        RecheckAction::SuppressExpired
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            expired: true,
            expired_facts: ExpiredFacts {
                is_cleanup_protected: true,
                ..input().expired_facts
            },
            ..input()
        }),
        RecheckAction::SuppressExpired
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            expired: true,
            remove_by_id_allowed: false,
            ..input()
        }),
        RecheckAction::SuppressExpired
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            expired: true,
            remove_supported: false,
            ..input()
        }),
        RecheckAction::ReleaseExpired
    );
}

#[test]
fn progresso_derivado_nao_vira_remocao_direta() {
    assert_eq!(
        recheck_step(&RecheckInput {
            derived_stalled: true,
            expired: true,
            ..input()
        }),
        RecheckAction::TerminalProgress
    );
}

#[test]
fn expira_mesmo_se_morte_ou_stall_ainda_nao_atingiu_limiar() {
    assert_eq!(
        recheck_step(&RecheckInput {
            state: Some("dead".into()),
            expired: true,
            ..input()
        }),
        RecheckAction::RemoveExpired
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            stalled: true,
            expired: true,
            ..input()
        }),
        RecheckAction::RemoveExpired
    );
    assert_eq!(
        recheck_step(&RecheckInput {
            state: Some("dead".into()),
            derived_stalled: true,
            ..input()
        }),
        RecheckAction::Pending
    );
}

#[test]
fn streaks_independentes_e_sem_resposta_nao_apaga_evidencia() {
    let sample = RecheckInput {
        dead_streak: 1,
        stall_streak: 2,
        ..input()
    };
    assert_eq!(
        recheck_streaks(&RecheckInput {
            state: Some("dead".into()),
            ..sample.clone()
        }),
        RecheckStreaks {
            dead: 2,
            stalled: 2
        }
    );
    assert_eq!(
        recheck_streaks(&RecheckInput {
            stalled: true,
            ..sample.clone()
        }),
        RecheckStreaks {
            dead: 1,
            stalled: 3
        }
    );
    let no_response = RecheckInput {
        status_ok: false,
        state: None,
        ..sample.clone()
    };
    assert_eq!(recheck_step(&no_response), RecheckAction::Unknown);
    assert_eq!(
        recheck_streaks(&no_response),
        RecheckStreaks {
            dead: 1,
            stalled: 2
        }
    );
    assert_eq!(
        recheck_streaks(&sample),
        RecheckStreaks {
            dead: 0,
            stalled: 0
        }
    );
}

#[test]
fn unknown_explicito_nao_condena_e_estado_observado_reinicia_streaks() {
    let unknown = RecheckInput {
        state: Some("unknown".into()),
        dead_streak: 1,
        stall_streak: 2,
        ..input()
    };
    assert_eq!(recheck_step(&unknown), RecheckAction::Pending);
    assert_eq!(
        recheck_streaks(&unknown),
        RecheckStreaks {
            dead: 0,
            stalled: 0
        }
    );
}
