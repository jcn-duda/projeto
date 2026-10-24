use super::*;

#[test]
fn test_starvation_discovery_never_ran_fura_fila() {
    let now = 1_000_000;
    let mut a = SiteRuntime::new("a");
    a.open_run_id = Some(1);
    a.last_active_at = now;

    let mut b = SiteRuntime::new("b");
    b.last_active_at = 0; // nunca rodou

    let deps = MockSelectDeps::new().with_counters(|id| {
        if id == "a" {
            SiteCounters::new(5, 5, 0, 0, 0)
        } else {
            SiteCounters::default()
        }
    });

    let config = CrawlerSiteConfig::new(true, 100, 60);

    let result = select_next(
        &["a", "b"],
        |id| if id == "b" { b.clone() } else { a.clone() },
        |_| config.clone(),
        &deps,
        now,
    );

    assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("b"));
    assert_eq!(
        result.chosen.as_ref().and_then(|c| c.due),
        Some(DueClass::Discovery)
    );
}

#[test]
fn test_starvation_discovery_intervalo_expirado_fura_fila() {
    let now = 10_000_000;
    let mut a = SiteRuntime::new("a");
    a.open_run_id = Some(1);
    a.last_active_at = now;

    let mut b = SiteRuntime::new("b");
    // Intervalo de 60 min = 3_600_000 ms. 61 min atrás = expirado!
    b.last_active_at = now - (61 * 60_000);

    let deps = MockSelectDeps::new().with_counters(|id| {
        if id == "a" {
            SiteCounters::new(5, 5, 0, 0, 0)
        } else {
            SiteCounters::default()
        }
    });

    let config = CrawlerSiteConfig::new(true, 100, 60);

    let result = select_next(
        &["a", "b"],
        |id| if id == "b" { b.clone() } else { a.clone() },
        |_| config.clone(),
        &deps,
        now,
    );

    assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("b"));
}

#[test]
fn test_starvation_discovery_dentro_do_intervalo_nao_fura_fila() {
    let now = 10_000_000;
    let mut a = SiteRuntime::new("a");
    a.open_run_id = Some(1);
    a.last_active_at = now;

    let mut b = SiteRuntime::new("b");
    // Intervalo de 60 min. 30 min atrás = dentro do intervalo.
    b.last_active_at = now - (30 * 60_000);

    let deps = MockSelectDeps::new().with_counters(|id| {
        if id == "a" {
            SiteCounters::new(5, 5, 0, 0, 0)
        } else {
            SiteCounters::default()
        }
    });

    let config = CrawlerSiteConfig::new(true, 100, 60);

    let result = select_next(
        &["a", "b"],
        |id| if id == "b" { b.clone() } else { a.clone() },
        |_| config.clone(),
        &deps,
        now,
    );

    // a (Item) deve vencer porque b (Discovery) não está com fome
    assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("a"));
    assert_eq!(
        result.chosen.as_ref().and_then(|c| c.due),
        Some(DueClass::Item)
    );
}

#[test]
fn test_starvation_multiplas_descobertas_vence_mais_antiga() {
    let now = 10_000_000;
    let mut a = SiteRuntime::new("a");
    a.last_active_at = now - (70 * 60_000); // 70 min atrás

    let mut b = SiteRuntime::new("b");
    b.last_active_at = now - (120 * 60_000); // 120 min atrás (mais faminto)

    let mut c = SiteRuntime::new("c");
    c.last_active_at = 0; // nunca rodou (last_active_at 0 é o menor!)

    let deps = MockSelectDeps::new();
    let config = CrawlerSiteConfig::new(true, 100, 60);

    let result = select_next(
        &["a", "b", "c"],
        |id| match id {
            "a" => a.clone(),
            "b" => b.clone(),
            _ => c.clone(),
        },
        |_| config.clone(),
        &deps,
        now,
    );

    // c tem last_active_at = 0, menor de todos
    assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("c"));
}

#[test]
fn test_fairness_ordem_mesma_classe_e_desempate() {
    let mut a = SiteRuntime::new("a");
    a.open_run_id = Some(1);
    a.last_active_at = 900;

    let mut b = SiteRuntime::new("b");
    b.open_run_id = Some(2);
    b.last_active_at = 100; // mais antigo

    let deps = MockSelectDeps::new().with_counters(|_| SiteCounters::new(5, 5, 0, 0, 0));
    let config = CrawlerSiteConfig::default();

    let result = select_next(
        &["a", "b"],
        |id| if id == "b" { b.clone() } else { a.clone() },
        |_| config.clone(),
        &deps,
        1000,
    );

    assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("b"));

    // Desempate por ordem na lista de config quando last_active_at é igual
    a.last_active_at = 100;
    b.last_active_at = 100;

    let result_tie = select_next(
        &["a", "b"],
        |id| if id == "b" { b.clone() } else { a.clone() },
        |_| config.clone(),
        &deps,
        1000,
    );

    assert_eq!(result_tie.chosen.as_ref().map(|c| c.id.as_str()), Some("a"));

    let result_tie_rev = select_next(
        &["b", "a"],
        |id| if id == "b" { b.clone() } else { a.clone() },
        |_| config.clone(),
        &deps,
        1000,
    );

    assert_eq!(
        result_tie_rev.chosen.as_ref().map(|c| c.id.as_str()),
        Some("b")
    );
}

#[test]
fn test_by_fairness_funcao_pura() {
    let make_cand = |id: &str, last_active: i64| SiteCandidate {
        id: id.to_string(),
        config: CrawlerSiteConfig::default(),
        runtime: SiteRuntime {
            id: id.to_string(),
            last_active_at: last_active,
            ..Default::default()
        },
        due: Some(DueClass::Item),
        skip_reason: None,
    };

    let list = vec![
        make_cand("x", 500),
        make_cand("y", 100),
        make_cand("z", 500),
        make_cand("w", 50),
    ];

    let fair = by_fairness(&list);
    let ids: Vec<&str> = fair.iter().map(|c| c.id.as_str()).collect();
    // 50 (w) -> 100 (y) -> 500 (x, pos 0) -> 500 (z, pos 2)
    assert_eq!(ids, vec!["w", "y", "x", "z"]);
}
