#[cfg(test)]
use super::*;

#[test]
fn test_decode_evidence() {
    assert_eq!(
        decode_evidence("The.Walking.Dead.4&ordf;.Temporada.Completa.1080p"),
        "The.Walking.Dead.4ª.Temporada.Completa.1080p"
    );
    assert_eq!(
        decode_evidence("TWD.4&amp;#170;.Temporada.Completa.1080p"),
        "TWD.4ª.Temporada.Completa.1080p"
    );
    assert_eq!(
        decode_evidence("TWD.4&ordf Temporada.Completa"),
        "TWD.4ª Temporada.Completa"
    );
    assert_eq!(decode_evidence("4ordf"), "4ª");
    assert_eq!(decode_evidence("4#170;"), "4ª;");
}

#[test]
fn test_season_from_card_slug() {
    assert_eq!(
        season_from_card_slug("https://x/tv/twd/season/4&ordf;-temporada/"),
        Some(4)
    );
    assert_eq!(
        season_from_card_slug("https://x/tv/twd/season/temporada-4/"),
        Some(4)
    );
    assert_eq!(
        season_from_card_slug("https://x/tv/twd/season/1a-temporada/"),
        Some(1)
    );
    assert_eq!(
        season_from_card_slug("https://x/tv/twd/season/2ª-temporada/"),
        Some(2)
    );
    assert_eq!(
        season_from_card_slug("https://x/tv/twd/season/3o-temporada"),
        Some(3)
    );
    assert_eq!(
        season_from_card_slug("https://x/tv/twd/season/especial/"),
        None
    );
    assert_eq!(
        season_from_card_slug("https://x/tv/twd/season/temporada-100/"),
        None
    );
}

#[test]
fn test_trailing_season_of() {
    assert_eq!(trailing_season_of("East Blue1"), Some(1));
    assert_eq!(trailing_season_of("Enies Lobby9"), Some(9));
    assert_eq!(trailing_season_of("Show 2020"), None);
    assert_eq!(trailing_season_of("Show 0"), None);
    assert_eq!(trailing_season_of("Especial"), None);
    assert_eq!(trailing_season_of("Season 12 "), Some(12));
}

#[test]
fn test_declared_series_location_rules() {
    let base = LinkEvidence {
        card_season: None,
        card_title: String::new(),
        is_batch: false,
        real_title: None,
        dn: None,
        link_episode: None,
    };

    // Regra 1: dn vence
    assert_eq!(
        declared_series_location(&LinkEvidence {
            dn: Some("Stranger.Things.1TemporadaCompleta.1080p".into()),
            link_episode: Some(1),
            ..base.clone()
        }),
        SeriesLocation {
            season: Some(1),
            episode: None
        }
    );
    assert_eq!(
        declared_series_location(&LinkEvidence {
            dn: Some("Stranger.Things.S05E08.EPISODIO.FINAL".into()),
            link_episode: Some(3),
            ..base.clone()
        }),
        SeriesLocation {
            season: Some(5),
            episode: Some(8)
        }
    );
    assert_eq!(
        declared_series_location(&LinkEvidence {
            dn: Some("Stranger.Things.4Temporada2022VOLUME.1".into()),
            ..base.clone()
        }),
        SeriesLocation {
            season: Some(4),
            episode: None
        }
    );
    assert_eq!(
        declared_series_location(&LinkEvidence {
            dn: Some("Stranger.Things.Todas.as.Temporadas".into()),
            ..base.clone()
        }),
        SeriesLocation {
            season: None,
            episode: None
        }
    );

    // Regra 2: título do card / batch
    assert_eq!(
        declared_series_location(&LinkEvidence {
            is_batch: true,
            real_title: Some("BATCH – Reacher S01".into()),
            ..base.clone()
        }),
        SeriesLocation {
            season: Some(1),
            episode: None
        }
    );
    assert_eq!(
        declared_series_location(&LinkEvidence {
            card_title: "Stranger Things 4".into(),
            link_episode: Some(2),
            ..base.clone()
        }),
        SeriesLocation {
            season: Some(4),
            episode: Some(2)
        }
    );
    assert_eq!(
        declared_series_location(&LinkEvidence {
            real_title: Some("BATCH – Série Completa".into()),
            ..base.clone()
        }),
        SeriesLocation {
            season: None,
            episode: None
        }
    );

    // Regra 3: card_season
    assert_eq!(
        declared_series_location(&LinkEvidence {
            card_season: Some(5),
            link_episode: Some(3),
            ..base.clone()
        }),
        SeriesLocation {
            season: Some(5),
            episode: Some(3)
        }
    );
    assert_eq!(
        declared_series_location(&LinkEvidence {
            card_season: Some(2),
            is_batch: true,
            link_episode: Some(1),
            ..base.clone()
        }),
        SeriesLocation {
            season: Some(2),
            episode: None
        }
    );

    // Regra 4: dígito final do card
    assert_eq!(
        declared_series_location(&LinkEvidence {
            card_title: "East Blue1".into(),
            ..base.clone()
        }),
        SeriesLocation {
            season: Some(1),
            episode: None
        }
    );
    assert_eq!(
        declared_series_location(&LinkEvidence {
            card_title: "Show 2020".into(),
            ..base.clone()
        }),
        SeriesLocation {
            season: None,
            episode: None
        }
    );

    // Regra 5: raiz conservadora
    assert_eq!(
        declared_series_location(&LinkEvidence {
            card_title: "Especial".into(),
            ..base.clone()
        }),
        SeriesLocation {
            season: None,
            episode: None
        }
    );
}

#[test]
fn test_group_series_releases_twd() {
    let release = CrawlRelease {
            title: Some("The Walking Dead 4&#170; Temporada Completa DUAL 1080p".into()),
            magnet: Some(
                "magnet:?xt=urn:btih:abababababababababababababababababababab&dn=The.Walking.Dead.4%26ordf%3B.Temporada.Completa.1080p".into(),
            ),
            indexer: Some("vacatorrent".into()),
            tracker: Some("Vaca Torrent".into()),
            is_br: Some(true),
            seeders: Some(1),
            ..Default::default()
        };

    let groups = group_series_releases(
        &[SeriesReleaseEntry {
            release: release.clone(),
            request: SeriesLocation {
                season: Some(4),
                episode: None,
            },
        }],
        &GroupSeriesOptions::default(),
    );

    assert_eq!(groups.len(), 1);
    assert_eq!(groups[0].season, Some(4));
    assert_eq!(groups[0].episode, None);
    assert_eq!(groups[0].releases.len(), 1);
}

#[test]
fn test_pack_signature() {
    assert_eq!(
        pack_signature_parts(Some("1080p"), Some("DUAL"), Some("1.5 GB"), None).as_deref(),
        Some("s:1080p|DUAL|1.5gb")
    );
    assert_eq!(
        pack_signature_parts(None, None, Some("700,5 MB"), None).as_deref(),
        Some("s:-|-|700.5mb")
    );
    // Episode presente -> None
    assert_eq!(
        pack_signature_parts(Some("1080p"), Some("DUAL"), Some("1.5 GB"), Some(1)),
        None
    );
    // Sentinela 1 KB -> None
    assert_eq!(
        pack_signature_parts(Some("1080p"), Some("DUAL"), Some("1 KB"), None),
        None
    );
    assert_eq!(
        pack_signature_parts(Some("1080p"), Some("DUAL"), Some("1.00 kb"), None),
        None
    );
}

#[test]
fn test_repair_mangled_entities() {
    assert_eq!(repair_mangled_entities("4ordf"), "4ª");
    assert_eq!(repair_mangled_entities("1ordm"), "1º");
    assert_eq!(repair_mangled_entities("2 ordm"), "2º");
    assert_eq!(repair_mangled_entities("4#170"), "4ª");
    assert_eq!(repair_mangled_entities("4#xaa"), "4ª");
    assert_eq!(repair_mangled_entities("4#x00aa"), "4ª");
    assert_eq!(repair_mangled_entities("2#186"), "2º");
    assert_eq!(repair_mangled_entities("2#xba"), "2º");
    // Não altera quando há letra antes ou letra depois
    assert_eq!(repair_mangled_entities("Accordf"), "Accordf");
    assert_eq!(repair_mangled_entities("4ordfx"), "4ordfx");
}

#[test]
fn test_live_action_filtering() {
    let release = CrawlRelease {
        title: Some("One Piece Live Action 2023 S01 1080p".into()),
        magnet: Some("magnet:?xt=urn:btih:abababababababababababababababababababab".into()),
        ..Default::default()
    };

    // Sob o anime de 1999, o live action de 2023 é excluído!
    let groups = group_series_releases(
        &[SeriesReleaseEntry {
            release,
            request: SeriesLocation {
                season: Some(1),
                episode: None,
            },
        }],
        &GroupSeriesOptions {
            year: Some("1999"),
            by_declared_location: false,
        },
    );
    assert_eq!(groups.len(), 0);
}

#[test]
fn test_group_sorting_order() {
    let r_root = CrawlRelease {
        title: Some("Show Series Completa".into()),
        ..Default::default()
    };
    let r_s2 = CrawlRelease {
        title: Some("Show S02".into()),
        ..Default::default()
    };
    let r_s1 = CrawlRelease {
        title: Some("Show S01".into()),
        ..Default::default()
    };
    let r_s1e1 = CrawlRelease {
        title: Some("Show S01E01".into()),
        ..Default::default()
    };

    let entries = vec![
        SeriesReleaseEntry {
            release: r_root,
            request: SeriesLocation {
                season: None,
                episode: None,
            },
        },
        SeriesReleaseEntry {
            release: r_s2,
            request: SeriesLocation {
                season: Some(2),
                episode: None,
            },
        },
        SeriesReleaseEntry {
            release: r_s1e1,
            request: SeriesLocation {
                season: Some(1),
                episode: Some(1),
            },
        },
        SeriesReleaseEntry {
            release: r_s1,
            request: SeriesLocation {
                season: Some(1),
                episode: None,
            },
        },
    ];

    let groups = group_series_releases(
        &entries,
        &GroupSeriesOptions {
            year: None,
            by_declared_location: true,
        },
    );

    let keys: Vec<(Option<i64>, Option<i64>)> =
        groups.iter().map(|g| (g.season, g.episode)).collect();

    // Esperado: S1 (None), S1 (E1), S2 (None), Root (None, None)
    assert_eq!(
        keys,
        vec![
            (Some(1), None),
            (Some(1), Some(1)),
            (Some(2), None),
            (None, None)
        ]
    );
}
