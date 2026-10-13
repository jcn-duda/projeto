#[cfg(test)]
use super::*;

#[test]
fn test_clamps_delay_ms() {
    assert_eq!(clamp_delay_ms(-500), 0);
    assert_eq!(clamp_delay_ms(0), 0);
    assert_eq!(clamp_delay_ms(1500), 1500);
    assert_eq!(clamp_delay_ms(60_000), 60_000);
    assert_eq!(clamp_delay_ms(70_000), 60_000);
}

#[test]
fn test_clamps_max_per_hour() {
    assert_eq!(clamp_max_per_hour(-100), 1);
    assert_eq!(clamp_max_per_hour(0), 1);
    assert_eq!(clamp_max_per_hour(1), 1);
    assert_eq!(clamp_max_per_hour(1500), 1500);
    assert_eq!(clamp_max_per_hour(20_000), 20_000);
    assert_eq!(clamp_max_per_hour(25_000), 20_000);
}

#[test]
fn test_clamps_idle_window_ms() {
    assert_eq!(clamp_idle_window_ms(-1), 0);
    assert_eq!(clamp_idle_window_ms(600_000), 600_000);
    assert_eq!(clamp_idle_window_ms(4_000_000), 3_600_000);
}

#[test]
fn test_clamps_max_tries() {
    assert_eq!(clamp_max_tries(0), 1);
    assert_eq!(clamp_max_tries(3), 3);
    assert_eq!(clamp_max_tries(15), 10);
}

#[test]
fn test_clamps_error_pause_streak() {
    assert_eq!(clamp_error_pause_streak(0), 1);
    assert_eq!(clamp_error_pause_streak(5), 5);
    assert_eq!(clamp_error_pause_streak(200), 100);
}

#[test]
fn test_clamps_layout_canary() {
    assert_eq!(clamp_layout_canary(0), 1);
    assert_eq!(clamp_layout_canary(10), 10);
    assert_eq!(clamp_layout_canary(500), 500);
    assert_eq!(clamp_layout_canary(1000), 1000);
    assert_eq!(clamp_layout_canary(2000), 1000);
}

#[test]
fn test_clamps_incremental_interval_min() {
    assert_eq!(clamp_incremental_interval_min(0), 1);
    assert_eq!(clamp_incremental_interval_min(60), 60);
    assert_eq!(clamp_incremental_interval_min(2000), 1440);
}

#[test]
fn test_clamps_series_limits() {
    assert_eq!(clamp_series_max_cards(0), 1);
    assert_eq!(clamp_series_max_cards(10), 10);
    assert_eq!(clamp_series_max_cards(150), 50);

    assert_eq!(clamp_series_max_buttons(0), 1);
    assert_eq!(clamp_series_max_buttons(40), 40);
    assert_eq!(clamp_series_max_buttons(300), 200);
}

#[test]
fn test_trava_seguranca_delay_ms_only_increases() {
    let live = CrawlerLiveConfig {
        delay_ms: 1000,
        ..Default::default()
    };

    // 1. Override tenta relaxar (delay menor que o global): TRAVA MANTÉM O PISO GLOBAL
    let faster_override = CrawlerSiteOverride {
        delay_ms: Some(500),
        ..Default::default()
    };
    let cfg1 = site_config_of(&live, "vacatorrent", Some(&faster_override));
    assert_eq!(
        cfg1.delay_ms, 1000,
        "Delay do site nao pode ser menor que o piso global!"
    );
    assert!(cfg1.overridden.contains(&"delayMs".to_string()));

    // 2. Override pede delay maior (mais educado com o site): PERMITIDO
    let slower_override = CrawlerSiteOverride {
        delay_ms: Some(3000),
        ..Default::default()
    };
    let cfg2 = site_config_of(&live, "vacatorrent", Some(&slower_override));
    assert_eq!(
        cfg2.delay_ms, 3000,
        "Delay do site pode aumentar para ritmo mais lento"
    );

    // 3. Override tenta valor negativo: clampeia para 0 e trava mantém o global
    let negative_override = CrawlerSiteOverride {
        delay_ms: Some(-100),
        ..Default::default()
    };
    let cfg3 = site_config_of(&live, "vacatorrent", Some(&negative_override));
    assert_eq!(cfg3.delay_ms, 1000);

    // 4. Override com valor muito alto: NÃO clampa em site_configOf (só no sanitizePatch)
    let huge_override = CrawlerSiteOverride {
        delay_ms: Some(999_999),
        ..Default::default()
    };
    let cfg4 = site_config_of(&live, "vacatorrent", Some(&huge_override));
    assert_eq!(
        cfg4.delay_ms, 999_999,
        "site_configOf não clampa override; clampa só no sanitizePatch"
    );

    // 5. Sem override de delay_ms: herda o global
    let no_delay_override = CrawlerSiteOverride {
        enabled: Some(true),
        ..Default::default()
    };
    let cfg5 = site_config_of(&live, "vacatorrent", Some(&no_delay_override));
    assert_eq!(cfg5.delay_ms, 1000);
    assert!(!cfg5.overridden.contains(&"delayMs".to_string()));
}

#[test]
fn test_trava_seguranca_max_per_hour_only_decreases() {
    let live = CrawlerLiveConfig {
        max_per_hour: 1500,
        ..Default::default()
    };

    // 1. Override tenta relaxar (teto maior que o global): TRAVA MANTÉM O TETO GLOBAL
    let greedy_override = CrawlerSiteOverride {
        max_per_hour: Some(5000),
        ..Default::default()
    };
    let cfg1 = site_config_of(&live, "vacatorrent", Some(&greedy_override));
    assert_eq!(
        cfg1.max_per_hour, 1500,
        "Teto de requisicoes por hora nao pode relaxar acima do global!"
    );
    assert!(cfg1.overridden.contains(&"maxPerHour".to_string()));

    // 2. Override pede teto menor (mais restritivo): PERMITIDO
    let polite_override = CrawlerSiteOverride {
        max_per_hour: Some(300),
        ..Default::default()
    };
    let cfg2 = site_config_of(&live, "vacatorrent", Some(&polite_override));
    assert_eq!(
        cfg2.max_per_hour, 300,
        "Teto de requisicoes por hora pode ser reduzido"
    );

    // 3. Override tenta valor zero/negativo: clampeia para 1 e min(1500, 1) = 1
    let zero_override = CrawlerSiteOverride {
        max_per_hour: Some(0),
        ..Default::default()
    };
    let cfg3 = site_config_of(&live, "vacatorrent", Some(&zero_override));
    assert_eq!(cfg3.max_per_hour, 1);

    // 4. Override tenta valor muito alto: NÃO clampa em site_configOf (só no sanitizePatch)
    let excessive_override = CrawlerSiteOverride {
        max_per_hour: Some(50_000),
        ..Default::default()
    };
    let cfg4 = site_config_of(&live, "vacatorrent", Some(&excessive_override));
    assert_eq!(
        cfg4.max_per_hour, 1500,
        "site_configOf aplica trava de segurança (min com global), não clamp"
    );

    // 5. Sem override de max_per_hour: herda o global
    let no_max_override = CrawlerSiteOverride {
        enabled: Some(true),
        ..Default::default()
    };
    let cfg5 = site_config_of(&live, "vacatorrent", Some(&no_max_override));
    assert_eq!(cfg5.max_per_hour, 1500);
    assert!(!cfg5.overridden.contains(&"maxPerHour".to_string()));
}

#[test]
fn test_site_config_of_enabled_and_dry_run() {
    let mut live = CrawlerLiveConfig {
        enabled: true,
        dry_run: true,
        sites: vec!["vacatorrent".to_string(), "bludv".to_string()],
        ..Default::default()
    };

    // Site na lista global sem override: enabled = true, dry_run = true
    let cfg_vaca = site_config_of(&live, "vacatorrent", None);
    assert!(cfg_vaca.enabled);
    assert!(cfg_vaca.dry_run);
    assert!(cfg_vaca.overridden.is_empty());

    // Site NÃO na lista global sem override: enabled = false
    let cfg_nerd = site_config_of(&live, "nerdfilmes", None);
    assert!(!cfg_nerd.enabled);
    assert!(cfg_nerd.dry_run);

    // Site NÃO na lista global com override enabled=true: enabled = true
    let enable_override = CrawlerSiteOverride {
        enabled: Some(true),
        ..Default::default()
    };
    let cfg_nerd_on = site_config_of(&live, "nerdfilmes", Some(&enable_override));
    assert!(cfg_nerd_on.enabled);
    assert!(cfg_nerd_on.overridden.contains(&"enabled".to_string()));

    // Site na lista global com override enabled=false: enabled = false
    let disable_override = CrawlerSiteOverride {
        enabled: Some(false),
        ..Default::default()
    };
    let cfg_vaca_off = site_config_of(&live, "vacatorrent", Some(&disable_override));
    assert!(!cfg_vaca_off.enabled);

    // Override dry_run = false
    let wet_override = CrawlerSiteOverride {
        dry_run: Some(false),
        ..Default::default()
    };
    let cfg_wet = site_config_of(&live, "vacatorrent", Some(&wet_override));
    assert!(!cfg_wet.dry_run);
    assert!(cfg_wet.overridden.contains(&"dryRun".to_string()));

    // Override mapeado via site_overrides do live
    live.site_overrides.insert(
        "comandotorrents".to_string(),
        CrawlerSiteOverride {
            enabled: Some(true),
            dry_run: Some(false),
            delay_ms: Some(2500),
            max_per_hour: Some(500),
        },
    );
    let cfg_comando = site_config_of(&live, "comandotorrents", None);
    assert!(cfg_comando.enabled);
    assert!(!cfg_comando.dry_run);
    assert_eq!(cfg_comando.delay_ms, 2500);
    assert_eq!(cfg_comando.max_per_hour, 500);
    assert_eq!(
        cfg_comando.overridden,
        vec!["enabled", "dryRun", "delayMs", "maxPerHour"]
    );
}

#[test]
fn test_series_limits_extraction() {
    let live = CrawlerLiveConfig {
        series_enabled: true,
        series_max_cards: 12,
        series_max_buttons: 45,
        ..Default::default()
    };
    let limits = series_limits_of(&live);
    assert!(limits.enabled);
    assert_eq!(limits.max_cards, 12);
    assert_eq!(limits.max_buttons, 45);

    let site_cfg = site_config_of(&live, "vacatorrent", None);
    let site_limits = site_cfg.series_limits();
    assert_eq!(site_limits, limits);
}

#[test]
fn test_known_sites_and_cadence() {
    let mut live = CrawlerLiveConfig {
        sites: vec!["vacatorrent".to_string(), "bludv".to_string()],
        delay_ms: 1000,
        ..Default::default()
    };
    live.site_overrides.insert(
        "nerdfilmes".to_string(),
        CrawlerSiteOverride {
            enabled: Some(true),
            delay_ms: Some(2000),
            ..Default::default()
        },
    );
    live.site_overrides.insert(
        "vacatorrent".to_string(),
        CrawlerSiteOverride {
            enabled: Some(true),
            delay_ms: Some(5000), // aumentou para 5000
            ..Default::default()
        },
    );

    let sites = known_sites(&live);
    assert_eq!(sites, vec!["vacatorrent", "bludv", "nerdfilmes"]);

    // bludv enabled (sem override): delay 1000
    // nerdfilmes enabled (override): delay max(1000, 2000) = 2000
    // vacatorrent enabled (override): delay max(1000, 5000) = 5000
    // Cadencia minima entre habilitados: 1000 (do bludv)
    assert_eq!(cadence_delay_ms(&live), 1000);

    // Se bludv for desabilitado por override:
    live.site_overrides.insert(
        "bludv".to_string(),
        CrawlerSiteOverride {
            enabled: Some(false),
            ..Default::default()
        },
    );
    // Agora os habilitados sao nerdfilmes (2000) e vacatorrent (5000). Menor: 2000.
    assert_eq!(cadence_delay_ms(&live), 2000);

    let with_cad = with_cadence(&live);
    assert_eq!(with_cad.delay_ms, 2000);
}

#[test]
fn test_serde_camel_and_snake_case() {
    let json_data = r#"{
            "enabled": true,
            "dryRun": false,
            "delayMs": 1500,
            "maxPerHour": 800,
            "idleWindowMs": 300000,
            "maxTries": 5,
            "errorPauseStreak": 10,
            "layoutCanary": 20,
            "incrementalIntervalMin": 120,
            "seriesEnabled": true,
            "seriesMaxCards": 15,
            "seriesMaxButtons": 50,
            "requireProbe": true,
            "sites": ["vacatorrent"],
            "siteOverrides": {
                "vacatorrent": {
                    "delayMs": 2500,
                    "maxPerHour": 600
                }
            }
        }"#;

    let parsed: CrawlerLiveConfig = serde_json::from_str(json_data).expect("deserialization ok");
    assert!(parsed.enabled);
    assert!(!parsed.dry_run);
    assert_eq!(parsed.delay_ms, 1500);
    assert_eq!(parsed.max_per_hour, 800);
    assert!(parsed.require_probe);
    let over = parsed.site_overrides.get("vacatorrent").unwrap();
    assert_eq!(over.delay_ms, Some(2500));
    assert_eq!(over.max_per_hour, Some(600));

    let reserialized = serde_json::to_string(&parsed).expect("serialization ok");
    assert!(reserialized.contains("\"delayMs\":1500"));
    assert!(reserialized.contains("\"maxPerHour\":800"));
}
