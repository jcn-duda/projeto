//! Testes do motor do raspador (C4).
//!
//! Foco em:
//! - `MotorConfig::default()` tem valores sensíveis
//! - `CrawlWorkResult` serializa/deserializa corretamente (roundtrip JSON)
//! - `CrawlResultStatus` kebab-case: "no-torrent", "no-work"
//! - `MotorStatus` serializa para JSON válido

use super::types::*;

#[test]
fn motor_config_default_valores_sensiveis() {
    let cfg = MotorConfig::default();

    // Paralelismo modesto para não sobrecarregar sites
    assert_eq!(cfg.max_parallel, 3);
    // Delay de 1s entre ticks
    assert_eq!(cfg.delay_ms, 1000);
    // Limite de 1500 páginas/hora
    assert_eq!(cfg.max_per_hour, 1500);
    // Máximo de 3 tentativas por URL
    assert_eq!(cfg.max_tries, 3);
    // Pausa após 5 erros consecutivos
    assert_eq!(cfg.error_pause_streak, 5);
    // Janela de ociosidade de 10 minutos
    assert_eq!(cfg.idle_window_ms, 600_000);
    // Prazo duro de ~11.6 minutos por passo
    assert_eq!(cfg.step_deadline_ms, 700_000);
    // Prazo duro com FlareSolverr: ~44 minutos
    assert_eq!(cfg.flare_step_deadline_ms, 2_660_000);
    // URL do Node padrão
    assert_eq!(cfg.node_url, "http://127.0.0.1:3000");
    // Token vazio por padrão
    assert!(cfg.admin_token.is_empty());
}

#[test]
fn crawl_result_status_kebab_case() {
    // Verifica que a serialização kebab-case funciona para todos os variants
    assert_eq!(
        serde_json::to_string(&CrawlResultStatus::Done).unwrap(),
        "\"done\""
    );
    assert_eq!(
        serde_json::to_string(&CrawlResultStatus::NoTorrent).unwrap(),
        "\"no-torrent\""
    );
    assert_eq!(
        serde_json::to_string(&CrawlResultStatus::NoWork).unwrap(),
        "\"no-work\""
    );
    assert_eq!(
        serde_json::to_string(&CrawlResultStatus::Error).unwrap(),
        "\"error\""
    );
    assert_eq!(
        serde_json::to_string(&CrawlResultStatus::Simulated).unwrap(),
        "\"simulated\""
    );
    assert_eq!(
        serde_json::to_string(&CrawlResultStatus::Partial).unwrap(),
        "\"partial\""
    );
}

#[test]
fn crawl_result_status_deserializa_kebab_case() {
    // Verifica que a deserialização kebab-case funciona
    assert_eq!(
        serde_json::from_str::<CrawlResultStatus>("\"no-torrent\"").unwrap(),
        CrawlResultStatus::NoTorrent
    );
    assert_eq!(
        serde_json::from_str::<CrawlResultStatus>("\"no-work\"").unwrap(),
        CrawlResultStatus::NoWork
    );
    assert_eq!(
        serde_json::from_str::<CrawlResultStatus>("\"done\"").unwrap(),
        CrawlResultStatus::Done
    );
}

#[test]
fn crawl_work_result_roundtrip_json() {
    let result = CrawlWorkResult {
        url: "https://example.com/filme-123".to_string(),
        url_key: "example.com:filme-123".to_string(),
        site: "example".to_string(),
        status: CrawlResultStatus::Done,
        imdb: Some("tt1234567".to_string()),
        title: Some("Filme de Teste".to_string()),
        year: Some(2024),
        kind: "movie".to_string(),
        releases: vec![CrawlRawItem {
            title: "Release BR 1080p".to_string(),
            magnet: Some("magnet:?xt=urn:btih:abc123".to_string()),
            link: None,
            size: Some("4.2 GB".to_string()),
            seeders: Some(42),
            tracker: Some("tracker.br".to_string()),
            is_br: true,
        }],
        groups: vec![],
        unlocated: vec![],
        progress: None,
        request_cost: 1,
        error: String::new(),
    };

    // Serializa
    let json = serde_json::to_string(&result).expect("serializa CrawlWorkResult");

    // Deserializa
    let roundtrip: CrawlWorkResult =
        serde_json::from_str(&json).expect("deserializa CrawlWorkResult");

    // Verifica campos
    assert_eq!(roundtrip.url, result.url);
    assert_eq!(roundtrip.url_key, result.url_key);
    assert_eq!(roundtrip.site, result.site);
    assert_eq!(roundtrip.status, result.status);
    assert_eq!(roundtrip.imdb, result.imdb);
    assert_eq!(roundtrip.title, result.title);
    assert_eq!(roundtrip.year, result.year);
    assert_eq!(roundtrip.kind, result.kind);
    assert_eq!(roundtrip.releases.len(), 1);
    assert_eq!(roundtrip.releases[0].title, "Release BR 1080p");
    assert!(roundtrip.releases[0].is_br);
    assert_eq!(roundtrip.request_cost, 1);
    assert!(roundtrip.error.is_empty());
}

#[test]
fn crawl_work_result_com_grupos_series() {
    let result = CrawlWorkResult {
        url: "https://example.com/serie-s01".to_string(),
        url_key: "example.com:serie-s01".to_string(),
        site: "example".to_string(),
        status: CrawlResultStatus::Partial,
        imdb: Some("tt9876543".to_string()),
        title: Some("Série BR".to_string()),
        year: Some(2023),
        kind: "series".to_string(),
        releases: vec![],
        groups: vec![CrawlReleaseGroup {
            season: Some(1),
            episode: Some(3),
            releases: vec![CrawlRawItem {
                title: "S01E03 720p BR".to_string(),
                magnet: None,
                link: Some("https://example.com/dl/123".to_string()),
                size: Some("1.5 GB".to_string()),
                seeders: Some(10),
                tracker: None,
                is_br: true,
            }],
        }],
        unlocated: vec![],
        progress: Some(r#"{"season":1,"episode":3}"#.to_string()),
        request_cost: 2,
        error: String::new(),
    };

    let json = serde_json::to_string(&result).expect("serializa com grupos");
    let roundtrip: CrawlWorkResult = serde_json::from_str(&json).expect("deserializa com grupos");

    assert_eq!(roundtrip.groups.len(), 1);
    assert_eq!(roundtrip.groups[0].season, Some(1));
    assert_eq!(roundtrip.groups[0].episode, Some(3));
    assert_eq!(roundtrip.groups[0].releases.len(), 1);
    assert_eq!(roundtrip.kind, "series");
}

#[test]
fn motor_status_serializa_json_valido() {
    let status = MotorStatus {
        active: true,
        sites: vec![
            SiteStatus {
                site_id: "nerd".to_string(),
                pending: 10,
                done: 50,
                no_torrent: 5,
                error: 2,
                inflight: 3,
                releases: 120,
            },
            SiteStatus {
                site_id: "mega".to_string(),
                pending: 0,
                done: 100,
                no_torrent: 10,
                error: 0,
                inflight: 0,
                releases: 250,
            },
        ],
        pages_this_hour: 150,
        global_paused: false,
    };

    let json = serde_json::to_string(&status).expect("serializa MotorStatus");

    // Verifica que o JSON é válido e contém os campos esperados
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("JSON válido");
    assert!(parsed["active"].as_bool().unwrap());
    assert_eq!(parsed["pages_this_hour"], 150);
    assert!(!parsed["global_paused"].as_bool().unwrap());
    assert!(parsed["sites"].is_array());
    assert_eq!(parsed["sites"].as_array().unwrap().len(), 2);
    assert_eq!(parsed["sites"][0]["site_id"], "nerd");
    assert_eq!(parsed["sites"][0]["pending"], 10);
    assert_eq!(parsed["sites"][1]["site_id"], "mega");
}

#[test]
fn motor_status_roundtrip_completo() {
    let original = MotorStatus {
        active: false,
        sites: vec![],
        pages_this_hour: 0,
        global_paused: true,
    };

    let json = serde_json::to_string(&original).unwrap();
    let roundtrip: MotorStatus = serde_json::from_str(&json).unwrap();

    assert!(!roundtrip.active);
    assert_eq!(roundtrip.pages_this_hour, 0);
    assert!(roundtrip.global_paused);
    assert!(roundtrip.sites.is_empty());
}
