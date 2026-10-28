use adom_core::{DecideSeedsStopInput, SeedsStopReason};

use super::{
    purge_seeds, seeds_stop, seeds_stop_gate, SeedsGateOutcome, SeedsQueueEntry, SEEDS_POOL,
};

#[test]
fn dublado_tocavel_para_seeds_e_cache_sem_excecao_para() {
    let br = seeds_stop(&DecideSeedsStopInput {
        has_cached_dubbed: true,
        cached_count: 1,
        rare: true,
        rare_threshold: 1,
        adapter_cache_check: true,
        rare_over_cached: true,
    });
    assert_eq!(br.stop, Some(SeedsStopReason::StopHasBr));
    let cached = seeds_stop(&DecideSeedsStopInput {
        has_cached_dubbed: false,
        cached_count: 2,
        rare: false,
        rare_threshold: 0,
        adapter_cache_check: true,
        rare_over_cached: false,
    });
    assert_eq!(cached.stop, Some(SeedsStopReason::StopHasCached));
}

#[test]
fn raro_acima_do_cache_so_passa_com_todas_as_provas() {
    let decision = seeds_stop(&DecideSeedsStopInput {
        has_cached_dubbed: false,
        cached_count: 1,
        rare: true,
        rare_threshold: 2,
        adapter_cache_check: true,
        rare_over_cached: true,
    });
    assert_eq!(decision.stop, None);
    assert!(decision.rare_over_cached);
}

fn entry(hash: &str, pool: &str) -> SeedsQueueEntry {
    SeedsQueueEntry {
        info_hash: hash.to_string(),
        pool: pool.to_string(),
    }
}

fn stop_input() -> DecideSeedsStopInput {
    DecideSeedsStopInput {
        has_cached_dubbed: false,
        cached_count: 0,
        rare: false,
        rare_threshold: 0,
        adapter_cache_check: true,
        rare_over_cached: false,
    }
}

#[test]
fn purga_sem_cache_remove_so_a_fila_de_seeds() {
    let fila = vec![
        entry("br1", "br"),
        entry("any1", "any"),
        entry("s1", SEEDS_POOL),
        entry("s2", SEEDS_POOL),
    ];
    let plan = purge_seeds(&fila, None);
    assert_eq!(plan.removed_count(), 2);
    assert_eq!(plan.released_hashes(), vec!["s1", "s2"]);
    // O dublado e o any NUNCA saem por decisão sobre sementes.
    assert_eq!(plan.keep.len(), 2);
    assert!(plan.complement_hashes().is_empty());
}

#[test]
fn purga_por_cache_preserva_a_seed_que_ainda_falta() {
    let fila = vec![
        entry("br1", "br"),
        entry("s1", SEEDS_POOL),
        entry("s2", SEEDS_POOL),
    ];
    let plan = purge_seeds(&fila, Some(&["S1".to_string()]));
    assert_eq!(plan.released_hashes(), vec!["s1"]);
    // O que sobra vira o complemento relaxado da próxima passagem.
    assert_eq!(plan.complement_hashes(), vec!["s2"]);
}

#[test]
fn stop_gate_purga_a_fila_inteira_e_solta_os_holds() {
    let input = DecideSeedsStopInput {
        cached_count: 1,
        ..stop_input()
    };
    let plan = seeds_stop_gate(
        &input,
        &[entry("s1", SEEDS_POOL), entry("s2", SEEDS_POOL)],
        &["s1".to_string(), "s2".to_string()],
        &[],
    );
    assert_eq!(
        plan.outcome,
        SeedsGateOutcome::Stop(SeedsStopReason::StopHasCached)
    );
    assert_eq!(plan.purge.removed_count(), 2);
    assert!(plan.immediate.is_empty());
    assert_eq!(plan.released, vec!["s1", "s2"]);
}

#[test]
fn gate_raro_so_corta_o_que_ja_esta_em_cache() {
    let input = DecideSeedsStopInput {
        cached_count: 1,
        rare: true,
        rare_threshold: 2,
        rare_over_cached: true,
        ..stop_input()
    };
    let plan = seeds_stop_gate(
        &input,
        &[
            entry("s1", SEEDS_POOL),
            entry("s2", SEEDS_POOL),
            entry("br1", "br"),
        ],
        &["s1".to_string(), "s2".to_string()],
        &["s1".to_string()],
    );
    assert_eq!(plan.outcome, SeedsGateOutcome::RareOverCached);
    assert_eq!(plan.purge.released_hashes(), vec!["s1"]);
    // A fila de seeds continua com a que falta; o `br` nunca é tocado.
    assert_eq!(plan.purge.complement_hashes(), vec!["s2"]);
    assert_eq!(plan.immediate, vec!["s2"]);
    assert_eq!(plan.released, vec!["s1"]);
}

#[test]
fn gate_libera_quando_nao_ha_nada_a_parar() {
    let plan = seeds_stop_gate(
        &stop_input(),
        &[entry("s1", SEEDS_POOL)],
        &["s1".to_string()],
        &[],
    );
    assert_eq!(plan.outcome, SeedsGateOutcome::Allow);
    assert!(plan.purge.is_empty());
    assert_eq!(plan.immediate, vec!["s1"]);
    assert!(plan.released.is_empty());
}
