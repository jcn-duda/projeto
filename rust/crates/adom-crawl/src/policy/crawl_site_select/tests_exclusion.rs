use super::*;

#[test]
fn test_exclusao_1_desabilitado() {
    let rt = SiteRuntime::new("s1");
    let config = CrawlerSiteConfig::new(false, 60, 60); // enabled = false
    let deps = MockSelectDeps::new();

    let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
    assert_eq!(candidates[0].skip_reason.as_deref(), Some("desabilitado"));
    assert_eq!(candidates[0].due, None);
}

#[test]
fn test_exclusao_2_pausado() {
    let mut rt = SiteRuntime::new("s1");
    rt.paused = true;
    let config = CrawlerSiteConfig::default();
    let deps = MockSelectDeps::new();

    let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
    assert_eq!(candidates[0].skip_reason.as_deref(), Some("pausado"));
    assert_eq!(candidates[0].due, None);
}

#[test]
fn test_exclusao_3_auto_pausa() {
    let mut rt = SiteRuntime::new("s1");
    rt.auto_pause = true;
    let config = CrawlerSiteConfig::default();
    let deps = MockSelectDeps::new();

    let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
    assert_eq!(candidates[0].skip_reason.as_deref(), Some("auto-pausa"));
    assert_eq!(candidates[0].due, None);
}

#[test]
fn test_exclusao_4_teto_horario_site_e_global() {
    let mut rt = SiteRuntime::new("s1");
    rt.hour_pages = 100;
    let config = CrawlerSiteConfig::new(true, 50, 60); // max_per_hour = 50, estourado
    let deps = MockSelectDeps::new();

    // Teto próprio do site
    let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
    assert_eq!(candidates[0].skip_reason.as_deref(), Some("teto-horario"));

    // Teto global atingido
    rt.hour_pages = 10;
    let deps_global = MockSelectDeps::new().with_global_cap_hit(|| true);
    let candidates_global = assess_sites(
        &["s1"],
        |_| rt.clone(),
        |_| config.clone(),
        &deps_global,
        1000,
    );
    assert_eq!(
        candidates_global[0].skip_reason.as_deref(),
        Some("teto-horario")
    );
}

#[test]
fn test_exclusao_4_mico_ritmo_proprio_ignora_teto() {
    let mut rt = SiteRuntime::new("mico");
    rt.hour_pages = 5000;
    let config = CrawlerSiteConfig::new(true, 50, 60);

    // Global hit e hour_pages estourados
    let deps = MockSelectDeps::new().with_global_cap_hit(|| true);

    let candidates = assess_sites(&["mico"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
    // mico tem is_own_pace == true, não deve ter teto-horario
    assert_ne!(candidates[0].skip_reason.as_deref(), Some("teto-horario"));
}

#[test]
fn test_exclusao_5_probe() {
    let rt = SiteRuntime::new("s1");
    let config = CrawlerSiteConfig::default();
    let deps = MockSelectDeps::new().with_probe_open(|_| false);

    let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
    assert_eq!(candidates[0].skip_reason.as_deref(), Some("probe"));
    assert_eq!(candidates[0].due, None);
}

#[test]
fn test_exclusao_6_sem_adaptador() {
    let now = 100_000;
    let mut rt = SiteRuntime::new("s1");
    rt.adapter_failed_at = now - 30_000; // falhou há 30s (< 60s)
    let config = CrawlerSiteConfig::default();
    let deps = MockSelectDeps::new();

    let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
    assert_eq!(candidates[0].skip_reason.as_deref(), Some("sem-adaptador"));

    // Falhou há 61s (>= 60s) => não barra mais com sem-adaptador
    rt.adapter_failed_at = now - 61_000;
    let candidates_ok = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
    assert_ne!(
        candidates_ok[0].skip_reason.as_deref(),
        Some("sem-adaptador")
    );
}

#[test]
fn test_exclusao_7_sem_trabalho() {
    let now = 100_000;
    let mut rt = SiteRuntime::new("s1");
    rt.next_discover_at = now + 50_000; // no futuro
    let config = CrawlerSiteConfig::default();
    // total > 0, mas sem páginas pendentes
    let deps = MockSelectDeps::new().with_counters(|_| SiteCounters::new(10, 0, 0, 0, 0));

    let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
    assert_eq!(candidates[0].skip_reason.as_deref(), Some("sem-trabalho"));
    assert_eq!(candidates[0].due, None);
}

#[test]
fn test_precedencia_estrita_das_regras_de_exclusao() {
    let now = 100_000;
    let mut rt = SiteRuntime::new("s1");
    rt.paused = true;
    rt.auto_pause = true;
    rt.hour_pages = 999;
    rt.adapter_failed_at = now - 1000;

    let mut config = CrawlerSiteConfig::new(false, 10, 60);
    let deps = MockSelectDeps::new()
        .with_global_cap_hit(|| true)
        .with_probe_open(|_| false);

    // 1. !config.enabled vence paused
    let c1 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
    assert_eq!(c1[0].skip_reason.as_deref(), Some("desabilitado"));

    // 2. paused vence auto_pause
    config.enabled = true;
    let c2 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
    assert_eq!(c2[0].skip_reason.as_deref(), Some("pausado"));

    // 3. auto_pause vence teto-horario
    rt.paused = false;
    let c3 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
    assert_eq!(c3[0].skip_reason.as_deref(), Some("auto-pausa"));

    // 4. teto-horario vence probe
    rt.auto_pause = false;
    let c4 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
    assert_eq!(c4[0].skip_reason.as_deref(), Some("teto-horario"));

    // 5. probe vence sem-adaptador
    let deps_no_cap = MockSelectDeps::new()
        .with_global_cap_hit(|| false)
        .with_probe_open(|_| false);
    config.max_per_hour = 1000; // teto não estoura
    let c5 = assess_sites(
        &["s1"],
        |_| rt.clone(),
        |_| config.clone(),
        &deps_no_cap,
        now,
    );
    assert_eq!(c5[0].skip_reason.as_deref(), Some("probe"));

    // 6. sem-adaptador vence sem-trabalho
    let deps_open = MockSelectDeps::new().with_counters(|_| SiteCounters::new(10, 0, 0, 0, 0));
    let c6 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps_open, now);
    assert_eq!(c6[0].skip_reason.as_deref(), Some("sem-adaptador"));
}

#[test]
fn test_due_class_variants() {
    let now = 100_000;
    let deps = MockSelectDeps::new();

    // 1. open_run_id => Item
    let mut rt = SiteRuntime::new("s1");
    rt.open_run_id = Some(42);
    let c = SiteCounters::default();
    assert_eq!(due_class(&rt, &deps, &c, now), Some(DueClass::Item));

    // 2. has_due_page via pending/error/inflight/partial
    rt.open_run_id = None;
    assert_eq!(
        due_class(&rt, &deps, &SiteCounters::new(5, 1, 0, 0, 0), now),
        Some(DueClass::Item)
    );
    assert_eq!(
        due_class(&rt, &deps, &SiteCounters::new(5, 0, 1, 0, 0), now),
        Some(DueClass::Item)
    );
    assert_eq!(
        due_class(&rt, &deps, &SiteCounters::new(5, 0, 0, 1, 0), now),
        Some(DueClass::Item)
    );
    assert_eq!(
        due_class(&rt, &deps, &SiteCounters::new(5, 0, 0, 0, 1), now),
        Some(DueClass::Item)
    );

    // 3. total == 0 => Discovery
    assert_eq!(
        due_class(&rt, &deps, &SiteCounters::new(0, 0, 0, 0, 0), now),
        Some(DueClass::Discovery)
    );

    // 4. total > 0 e now >= next_discover_at => Discovery
    rt.next_discover_at = now - 1;
    assert_eq!(
        due_class(&rt, &deps, &SiteCounters::new(5, 0, 0, 0, 0), now),
        Some(DueClass::Discovery)
    );

    // 5. total > 0 e now < next_discover_at => None
    rt.next_discover_at = now + 10_000;
    assert_eq!(
        due_class(&rt, &deps, &SiteCounters::new(5, 0, 0, 0, 0), now),
        None
    );
}

#[test]
fn test_due_class_recuperacao_pendente_vira_item() {
    let now = 100_000;
    let deps = MockSelectDeps::new();
    let counters = SiteCounters::new(5, 0, 0, 0, 0);

    // Baseline: sem recuperação, fila vazia e descoberta no futuro.
    let mut rt = SiteRuntime::new("s1");
    rt.next_discover_at = now + 10_000;
    assert_eq!(due_class(&rt, &deps, &counters, now), None);
    assert_eq!(
        due_class(&rt, &deps, &SiteCounters::new(0, 0, 0, 0, 0), now),
        Some(DueClass::Discovery)
    );

    // `need_simulated_recovery` => Item (mesmo sem rodada e sem fila).
    rt.need_simulated_recovery = true;
    assert_eq!(due_class(&rt, &deps, &counters, now), Some(DueClass::Item));
    assert_eq!(
        due_class(&rt, &deps, &SiteCounters::new(0, 0, 0, 0, 0), now),
        Some(DueClass::Item)
    );

    // `need_inflight_recovery` => Item.
    rt.need_simulated_recovery = false;
    rt.need_inflight_recovery = true;
    assert_eq!(due_class(&rt, &deps, &counters, now), Some(DueClass::Item));
}

#[test]
fn test_has_due_injecao_exata() {
    let now = 1000;
    let rt = SiteRuntime::new("s1");
    let counters = SiteCounters::new(10, 0, 0, 0, 0);

    // Injeção devolve true
    let deps_true = MockSelectDeps::new().with_has_due(|_, _| true);
    assert!(has_due_page(&deps_true, "s1", &counters, now));
    assert_eq!(
        due_class(&rt, &deps_true, &counters, now),
        Some(DueClass::Item)
    );

    // Injeção devolve false mesmo com contadores tendo pending
    let counters_pending = SiteCounters::new(10, 5, 0, 0, 0);
    let deps_false = MockSelectDeps::new().with_has_due(|_, _| false);
    assert!(!has_due_page(&deps_false, "s1", &counters_pending, now));
}

#[test]
fn test_apply_skip_reasons() {
    let mut candidates = vec![
        SiteCandidate {
            id: "s1".to_string(),
            config: CrawlerSiteConfig::default(),
            runtime: SiteRuntime::new("s1"),
            due: None,
            skip_reason: Some("pausado".to_string()),
        },
        SiteCandidate {
            id: "s2".to_string(),
            config: CrawlerSiteConfig::default(),
            runtime: SiteRuntime::new("s2"),
            due: Some(DueClass::Item),
            skip_reason: None,
        },
    ];

    apply_skip_reasons(&mut candidates);
    assert_eq!(
        candidates[0].runtime.skip_reason.as_deref(),
        Some("pausado")
    );
    assert_eq!(candidates[1].runtime.skip_reason, None);
}

#[test]
fn test_skip_reason_for() {
    let mut rt = SiteRuntime::new("s1");
    let config = CrawlerSiteConfig::default();

    // rt já tem skip_reason: precedência absoluta
    rt.skip_reason = Some("teto-horario".to_string());
    assert_eq!(
        skip_reason_for(&rt, &config, true).as_deref(),
        Some("teto-horario")
    );
    assert_eq!(
        skip_reason_for(&rt, &config, false).as_deref(),
        Some("teto-horario")
    );

    // sem skip_reason medido
    rt.skip_reason = None;
    assert_eq!(skip_reason_for(&rt, &config, true), None);
    assert_eq!(
        skip_reason_for(&rt, &config, false).as_deref(),
        Some("desabilitado")
    );

    let disabled_config = CrawlerSiteConfig::new(false, 60, 60);
    assert_eq!(
        skip_reason_for(&rt, &disabled_config, true).as_deref(),
        Some("desabilitado")
    );
}

#[test]
fn test_starve_ms() {
    let c1 = CrawlerSiteConfig::new(true, 60, 30);
    assert_eq!(starve_ms(&c1), 30 * 60_000);

    let c2 = CrawlerSiteConfig::new(true, 60, 0);
    assert_eq!(starve_ms(&c2), 60 * 60_000);

    let c3 = CrawlerSiteConfig::new(true, 60, -10);
    assert_eq!(starve_ms(&c3), 60 * 60_000);
}
