#[cfg(test)]
use super::*;
#[cfg(test)]
use crate::policy::crawl_site_select::{MockSelectDeps, SiteCounters};
#[cfg(test)]
use std::collections::HashMap;

fn make_test_cfg(delay_ms: i64) -> CrawlerSiteConfig {
    CrawlerSiteConfig {
        enabled: true,
        dry_run: true,
        delay_ms,
        max_per_hour: 1000,
        idle_window_ms: 0,
        max_tries: 3,
        error_pause_streak: 5,
        layout_canary: 10,
        incremental_interval_min: 60,
        series_enabled: true,
        series_max_cards: 10,
        series_max_buttons: 40,
        require_probe: false,
        overridden: Vec::new(),
    }
}

fn setup_runtimes(ids: &[&str]) -> HashMap<String, SiteRuntime> {
    ids.iter()
        .map(|id| {
            let mut rt = SiteRuntime::new(*id);
            rt.open_run_id = Some(1);
            (id.to_string(), rt)
        })
        .collect()
}

fn make_deps() -> MockSelectDeps {
    MockSelectDeps::new()
        .with_counters(|_| SiteCounters::new(5, 5, 0, 0, 0))
        .with_probe_open(|_| true)
        .with_global_cap_hit(|| false)
}

#[test]
fn test_parallel_max_parallel_and_inflight_exclusion() {
    let ids = vec!["a", "b", "c", "d"];
    let rts = setup_runtimes(&ids);
    let cfg = make_test_cfg(500);
    let deps = make_deps();
    let now = 1_000_000;

    // Sem inflight, max_parallel = 3 -> escolhe a, b, c
    let input = DispatchInput::new(
        ids.clone(),
        Vec::<&str>::new(),
        3,
        Vec::<&str>::new(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(chosen_ids, vec!["a", "b", "c"]);

    // inflight = [a, b], max_parallel = 3 -> só resta c
    let input = DispatchInput::new(
        ids.clone(),
        vec!["a", "b"],
        3,
        Vec::<&str>::new(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(chosen_ids, vec!["c"]);

    // inflight = [a, b, c], max_parallel = 3 -> zero vagas
    let input = DispatchInput::new(
        ids.clone(),
        vec!["a", "b", "c"],
        3,
        Vec::<&str>::new(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    assert_eq!(out.chosen.len(), 0);

    // max_parallel = 1 (modo serial) -> escolhe só a
    let input = DispatchInput::new(
        ids.clone(),
        Vec::<&str>::new(),
        1,
        Vec::<&str>::new(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(chosen_ids, vec!["a"]);
}

#[test]
fn test_flaresolverr_contention_single_slot() {
    let ids = vec!["rede", "bludv", "vaca"];
    let rts = setup_runtimes(&ids);
    let cfg = make_test_cfg(500);
    let deps = make_deps();
    let flare_sites = vec!["rede", "bludv"];
    let now = 1_000_000;

    // Com ambos livres, max_parallel = 3 -> escolhe "rede" (primeiro Flare) e "vaca" (não flare).
    // "bludv" fica de fora devido à trava de Flare único simultâneo!
    let input = DispatchInput::new(
        ids.clone(),
        Vec::<&str>::new(),
        3,
        flare_sites.clone(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(chosen_ids, vec!["rede", "vaca"]);

    // Se "rede" já está em inflight, nenhum outro Flare pode ser escolhido -> só "vaca"
    let input = DispatchInput::new(
        ids.clone(),
        vec!["rede"],
        3,
        flare_sites.clone(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(chosen_ids, vec!["vaca"]);
}

#[test]
fn test_pacing_by_site_delay_ms() {
    let ids = vec!["a", "b"];
    let mut rts = setup_runtimes(&ids);
    let cfg = make_test_cfg(500);
    let deps = make_deps();
    let now = 1_000_000;

    // "a" requisitou há 100ms (< 500ms) -> barrado por ritmo
    // "b" requisitou há 900ms (>= 500ms) -> liberado
    rts.get_mut("a").unwrap().last_active_at = now - 100;
    rts.get_mut("b").unwrap().last_active_at = now - 900;

    let input = DispatchInput::new(
        ids.clone(),
        Vec::<&str>::new(),
        3,
        Vec::<&str>::new(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(chosen_ids, vec!["b"]);
    assert!(out.paced.contains("a"));
    assert!(!out.paced.contains("b"));
}

#[test]
fn test_own_pace_mico_isolation() {
    let ids = vec!["a", "b", "c", "d", "mico"];
    let rts = setup_runtimes(&ids);
    let cfg = make_test_cfg(500);
    let deps = make_deps();
    let now = 1_000_000;

    // 1. Mico nunca é barrado por paced_out mesmo com last_active_at recente
    let mut rt_mico = SiteRuntime::new("mico");
    rt_mico.last_active_at = now - 50;
    assert!(!paced_out(&rt_mico, &cfg, now));

    // 2. Vagas cheias de sites comuns (a, b, c): Mico roda mesmo assim!
    let input = DispatchInput::new(
        ids.clone(),
        vec!["a", "b", "c"],
        3,
        Vec::<&str>::new(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(chosen_ids, vec!["mico"]);

    // 3. Mico em voo não consome vaga comum: os 3 normais ainda rodam
    let input = DispatchInput::new(
        ids.clone(),
        vec!["mico"],
        3,
        Vec::<&str>::new(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(chosen_ids, vec!["a", "b", "c"]);

    // 4. Tudo livre: Mico (por fora) + 3 normais
    let input = DispatchInput::new(
        ids.clone(),
        Vec::<&str>::new(),
        3,
        Vec::<&str>::new(),
        |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
        |_| cfg.clone(),
        &deps,
        now,
    );
    let out = pick_batch(input);
    let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(chosen_ids, vec!["mico", "a", "b", "c"]);
}
