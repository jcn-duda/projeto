use super::{eligible_evictions, EvictCandidate, EvictInput};

fn candidate(hash: &str) -> EvictCandidate {
    EvictCandidate {
        hash: hash.into(),
        pool: "any".into(),
        overflow: false,
        marker_matches_work: true,
        owned: true,
        held: false,
        protected: false,
        accepted_at: 10,
    }
}

#[test]
fn precisa_de_prova_br_e_pula_overflow_hold_sem_posse_e_marker_de_outra_obra() {
    let mut rows = vec![
        candidate("A"),
        candidate("B"),
        candidate("C"),
        candidate("D"),
        candidate("E"),
    ];
    rows[1].overflow = true;
    rows[2].held = true;
    rows[3].owned = false;
    rows[4].marker_matches_work = false;
    let input = EvictInput {
        current_ready_is_br: false,
        work_has_prior_br_ready: false,
        now: 100,
        min_age_ms: 20,
        candidates: rows.clone(),
    };
    assert!(eligible_evictions(&input).is_empty());
    let input = EvictInput {
        current_ready_is_br: true,
        work_has_prior_br_ready: false,
        now: 100,
        min_age_ms: 20,
        candidates: rows,
    };
    assert_eq!(eligible_evictions(&input), vec!["a"]);
}

#[test]
fn idade_minima_e_aplicada_e_hash_deduplicado() {
    let input = EvictInput {
        current_ready_is_br: true,
        work_has_prior_br_ready: false,
        now: 20,
        min_age_ms: 15,
        candidates: vec![candidate("x"), candidate("X")],
    };
    assert!(eligible_evictions(&input).is_empty());
}
