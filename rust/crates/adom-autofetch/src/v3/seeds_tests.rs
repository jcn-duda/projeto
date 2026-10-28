use adom_core::{DecideSeedsStopInput, SeedsStopReason};

use super::seeds_stop;

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
