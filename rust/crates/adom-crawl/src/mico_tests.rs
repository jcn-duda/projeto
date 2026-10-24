#[cfg(test)]
use super::*;
#[cfg(test)]
use std::collections::HashMap;

#[test]
fn test_stride_at() {
    assert_eq!(stride_at(0), 25);
    assert_eq!(stride_at(500), 25);
    assert_eq!(stride_at(999), 25);
    assert_eq!(stride_at(1000), 50);
    assert_eq!(stride_at(1050), 50);
    assert_eq!(stride_at(5000), 50);
}

#[test]
fn test_fnv1a_values() {
    assert_eq!(fnv1a("tt0133093"), 3640502656);
    assert_eq!(fnv1a("tt0468569"), 3799686459);
}

#[test]
fn test_bucket_lastmod_properties() {
    // Base: 2026-10-02 UTC (1790899200000 ms)
    let base = 1790899200000_i64;
    let l0 = bucket_lastmod("tt0133093", base, 14);
    assert_eq!(l0, "2026-09-24");

    // 1. Estável dentro do período de 14 dias (do início do balde start_day até +13 dias)
    let start_ms = 20720 * DAY_MS; // 2026-09-24T00:00:00Z
    for d in 0..14 {
        let now = start_ms + d * DAY_MS + 43_210;
        assert_eq!(bucket_lastmod("tt0133093", now, 14), l0);
    }

    // 2. Muda no período seguinte
    let l1 = bucket_lastmod("tt0468569", base, 14);
    assert_eq!(l1, "2026-09-19");
    let l2 = bucket_lastmod("tt0468569", base + 14 * DAY_MS, 14);
    assert_ne!(l1, l2);
    assert!(l2 > l1);
}

#[test]
fn test_parse_mico_url() {
    let base = "https://mico-leao-dublado-apiv-2.vercel.app";
    let movie_url = format!("{base}/crawl/movie/tt0133093/");
    let series_url = format!("{base}/crawl/series/tt0944947/");

    assert_eq!(
        parse_mico_url(&movie_url, Some(base)),
        Some(MicoParsedUrl {
            kind: MicoKind::Movie,
            imdb: "tt0133093".to_string(),
        })
    );
    assert_eq!(
        parse_mico_url(&series_url, Some(base)),
        Some(MicoParsedUrl {
            kind: MicoKind::Series,
            imdb: "tt0944947".to_string(),
        })
    );

    // Casos inválidos
    assert_eq!(
        parse_mico_url("https://inimigo.test/crawl/movie/tt0133093/", Some(base)),
        None
    );
    assert_eq!(
        parse_mico_url(&format!("{base}/filme/tt0133093/"), Some(base)),
        None
    );
    assert_eq!(
        parse_mico_url(&format!("{base}/crawl/movie/12345/"), Some(base)),
        None
    );
    assert_eq!(
        parse_mico_url(&format!("{base}/crawl/movie/tt0133093"), Some(base)),
        None
    );
    assert_eq!(
        parse_mico_url(&format!("{base}/crawl/tv/tt0133093/"), Some(base)),
        None
    );
    assert_eq!(parse_mico_url("não é url", Some(base)), None);
    assert_eq!(parse_mico_url("", Some(base)), None);
}

#[test]
fn test_list_target_episodes() {
    let mut episodes = HashMap::new();
    episodes.insert("3".to_string(), 4);
    episodes.insert("2".to_string(), 3);
    episodes.insert("1".to_string(), 2);

    let mut episode_aired = HashMap::new();
    episode_aired.insert("3:1".to_string(), "2022-05-27T00:00:00.000Z".to_string());
    episode_aired.insert("3:2".to_string(), "2022-05-27T00:00:00.000Z".to_string());
    episode_aired.insert("3:3".to_string(), "2099-01-01T00:00:00.000Z".to_string()); // futura
                                                                                     // 3:4 ausente
    episode_aired.insert("2:1".to_string(), "2017-10-27T00:00:00.000Z".to_string());
    episode_aired.insert("2:2".to_string(), "2017-10-27T00:00:00.000Z".to_string());
    episode_aired.insert("2:3".to_string(), "2017-10-27T00:00:00.000Z".to_string());
    episode_aired.insert("1:1".to_string(), "2016-07-15T00:00:00.000Z".to_string());
    episode_aired.insert("1:2".to_string(), "2016-07-15T00:00:00.000Z".to_string());

    let meta = SeriesMeta {
        episodes,
        episode_aired,
        name: Some("Stranger Things".to_string()),
        year: None,
    };

    let now = 1790899200000_i64; // 2026-10-02

    // maxSeasons = 1 -> S3
    let t1 = list_target_episodes(Some(&meta), 1, now);
    assert_eq!(
        t1,
        vec![
            TargetEpisode {
                season: 3,
                episode: 1
            },
            TargetEpisode {
                season: 3,
                episode: 2
            }
        ]
    );

    // maxSeasons = 2 -> S3 e S2
    let t2 = list_target_episodes(Some(&meta), 2, now);
    assert_eq!(
        t2,
        vec![
            TargetEpisode {
                season: 3,
                episode: 1
            },
            TargetEpisode {
                season: 3,
                episode: 2
            },
            TargetEpisode {
                season: 2,
                episode: 1
            },
            TargetEpisode {
                season: 2,
                episode: 2
            },
            TargetEpisode {
                season: 2,
                episode: 3
            },
        ]
    );

    // maxSeasons = 3 -> S3, S2 e S1
    let t3 = list_target_episodes(Some(&meta), 3, now);
    assert_eq!(t3.len(), 7);

    // Vazia
    assert_eq!(list_target_episodes(None, 2, now), vec![]);
}

#[test]
fn test_clean_title() {
    assert_eq!(
        clean_title("Coringa 2019 1080p DUAL 👥 12 💾 2.5 GB"),
        "Coringa 2019 1080p DUAL"
    );
    assert_eq!(clean_title("Matrix (brazilian, eng)"), "Matrix");
}
