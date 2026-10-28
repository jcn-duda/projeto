use super::*;
use std::cell::Cell;

fn candidate(hash: &str) -> QueueCandidate {
    serde_json::from_value(serde_json::json!({"infoHash": hash})).unwrap()
}
fn gates() -> DrainGates {
    DrainGates {
        search_key_present: true,
        queue_enabled: true,
        paused: false,
        adapter_available: true,
        budget_blocked: false,
        rd_cooldown: false,
        account_blocked: false,
        refusals: 0,
        max_refusals: 3,
    }
}

#[test]
fn gate_fechado_preserva_inteira_sem_podar_obsoletos() {
    let calls = Cell::new(0);
    let result = drain_next(
        &DrainGates {
            paused: true,
            ..gates()
        },
        vec![candidate("dead")],
        |_| {
            calls.set(calls.get() + 1);
            Ok::<_, ()>(true)
        },
        |_| Ok(false),
        |_| Ok(Some(1)),
    )
    .unwrap();
    assert_eq!(calls.get(), 0);
    match result {
        DrainNext::Blocked { reason, queue } => {
            assert_eq!(reason, DrainBlock::Paused);
            assert_eq!(queue[0].info_hash, "dead");
        }
        _ => panic!("deveria bloquear"),
    }
}

#[test]
fn lock_e_orcamento_reenfileiram_primeiro_e_exigem_rollback_correto() {
    for (lock, budget) in [(false, false), (true, false)] {
        let selection = select_drain_candidate(
            vec![candidate("a"), candidate("b")],
            |_| Ok::<_, ()>(false),
            |_| Ok(false),
            |_| Ok(Some(7)),
        )
        .unwrap();
        match finish_drain_selection(selection, lock, budget) {
            DrainDecision::Requeue {
                queue,
                lease,
                release_lock,
                budget_backoff,
            } => {
                assert_eq!(
                    queue
                        .iter()
                        .map(|c| c.info_hash.as_str())
                        .collect::<Vec<_>>(),
                    ["a", "b"]
                );
                assert_eq!(lease, 7);
                assert_eq!(release_lock, lock);
                assert_eq!(budget_backoff, lock);
            }
            _ => panic!("esperado requeue"),
        }
    }
}

#[test]
fn aceite_exige_lock_orcamento_e_preserva_fila_restante() {
    let selection = select_drain_candidate(
        vec![candidate("a"), candidate("b")],
        |_| Ok::<_, ()>(false),
        |_| Ok(false),
        |_| Ok(Some(7)),
    )
    .unwrap();
    match finish_drain_selection(selection, true, true) {
        DrainDecision::Start {
            candidate,
            remaining,
            lease,
        } => {
            assert_eq!(candidate.info_hash, "a");
            assert_eq!(remaining[0].info_hash, "b");
            assert_eq!(lease, 7);
        }
        _ => panic!("esperado início"),
    }
}

#[test]
fn selecao_inconsistente_nao_perde_candidato() {
    let selection = DrainSelection::<()> {
        next: Some(candidate("a")),
        remaining: vec![candidate("b")],
        lease: None,
        cap_deferred: 0,
    };
    match finish_drain_selection(selection, true, true) {
        DrainDecision::InvalidSelection { queue } => assert_eq!(queue.len(), 2),
        _ => panic!("esperado inválido"),
    }
}

fn pooled(hash: &str, pool: &str) -> QueueCandidate {
    serde_json::from_value(serde_json::json!({"infoHash": hash, "pool": pool})).unwrap()
}

#[test]
fn fila_preordenada_br_any_seeds_preserva_prioridade_da_cascata() {
    let selection = select_drain_candidate(
        vec![
            pooled("br", "br"),
            pooled("any", "any"),
            pooled("seed", "seeds"),
        ],
        |_| Ok::<_, ()>(false),
        |_| Ok(false),
        |_| Ok(Some(1)),
    )
    .unwrap();
    assert_eq!(selection.next.unwrap().info_hash, "br");
    assert_eq!(
        selection
            .remaining
            .iter()
            .map(|c| c.info_hash.as_str())
            .collect::<Vec<_>>(),
        ["any", "seed"]
    );
}

#[test]
fn sonda_pendente_adia_seeds_sem_purga_e_cap_tenta_proximo() {
    use super::super::{probe_blocks_seeds, ProbeState};
    let selection = select_drain_candidate(
        vec![
            pooled("seed", "seeds"),
            pooled("br_cap", "br"),
            pooled("br_ok", "br"),
        ],
        |_| Ok::<_, ()>(false),
        |c| {
            Ok(c.pool.as_deref() == Some("seeds")
                && probe_blocks_seeds(Some(ProbeState::Pending), 100, 1))
        },
        |c| {
            Ok(if c.info_hash == "br_cap" {
                None
            } else {
                Some(7)
            })
        },
    )
    .unwrap();
    assert_eq!(selection.next.unwrap().info_hash, "br_ok");
    assert_eq!(
        selection
            .remaining
            .iter()
            .map(|c| c.info_hash.as_str())
            .collect::<Vec<_>>(),
        ["br_cap", "seed"]
    );
    assert_eq!(selection.cap_deferred, 1);
}
