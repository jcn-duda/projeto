use super::*;

fn cfg() -> ObraLiveConfig {
    ObraLiveConfig {
        auto_fetch_max: 3.0,
        auto_fetch_top_seeds_max: 2.0,
        auto_fetch_rare_max: 4.0,
        auto_fetch_ttl: 3600.0,
    }
}

fn input(imdb: &str, season: Option<f64>, episode: Option<f64>) -> ObraIdentityInput {
    ObraIdentityInput {
        adapter_id: "pm".into(),
        account: "a1".into(),
        imdb_id: Some(imdb.into()),
        season,
        episode,
        ..Default::default()
    }
}

#[test]
fn identidade_cobre_casos_principais() {
    assert_eq!(
        obra_identity(&input("tt1234567", None, None)),
        "pm:a1:movie:tt1234567::"
    );
    assert_eq!(
        obra_identity(&input("tt7000001", Some(1.0), Some(2.0))),
        "pm:a1:series:tt7000001:1:2"
    );
    let pack = ObraIdentityInput {
        is_pack: true,
        ..input("tt7000001", Some(1.0), Some(2.0))
    };
    assert_eq!(obra_identity(&pack), "pm:a1:series:tt7000001:1:");
    let no_imdb = ObraIdentityInput {
        adapter_id: "pm".into(),
        account: "a".into(),
        search_key: Some("sk".into()),
        ..Default::default()
    };
    assert!(obra_identity(&no_imdb).starts_with("pm:a:movie:sk:"));
    let explicit = ObraIdentityInput {
        type_: Some("movie".into()),
        ..input("tt100", Some(1.0), None)
    };
    assert!(obra_identity(&explicit).contains(":movie:"));
}

#[test]
fn pool_cap_e_seeds_rare() {
    let c = cfg();
    assert_eq!(pool_cap("br", false, &c), 3);
    assert_eq!(pool_cap("seeds", false, &c), 2);
    assert_eq!(pool_cap("seeds", true, &c), 4);
    assert_eq!(pool_cap("any", false, &c), 1);
    assert!(!seeds_rare("br", true, None, &c));
    assert!(seeds_rare("seeds", true, None, &c));
    assert!(seeds_rare("seeds", false, Some(4.0), &c));
    assert!(!seeds_rare("seeds", false, Some(2.0), &c));
}

#[test]
fn window_ms_e_counts() {
    assert_eq!(window_ms(&cfg()), 3_600_000.0);
    let entries = vec![
        ObraRecordEntry {
            pool: "br".into(),
            ..Default::default()
        },
        ObraRecordEntry {
            pool: "br".into(),
            ..Default::default()
        },
        ObraRecordEntry {
            pool: "seeds".into(),
            ..Default::default()
        },
    ];
    let pending = vec![PendingReservation {
        pool: "any".into(),
        ..Default::default()
    }];
    assert_eq!(
        counts_from(&entries, &pending),
        ObraCounts {
            br: 2,
            any: 1,
            seeds: 1,
            total: 4
        }
    );
}

#[test]
fn combined_view_e_read_record() {
    let entries = vec![ObraRecordEntry {
        pool: "br".into(),
        quality: Some("720p".into()),
        ..Default::default()
    }];
    let pending = vec![PendingReservation {
        pool: "br".into(),
        quality: Some("1080p".into()),
        overflow: true,
        ..Default::default()
    }];
    let view = combined_view(&entries, &pending);
    assert_eq!(view.len(), 2);
    assert_eq!(view[1].quality, "1080p");
    assert!(view[1].overflow);
    // read_record: defensivo
    let raw = serde_json::json!({"entries": [{"hash": "AABB", "pool": "br", "acceptedAt": 1000.0, "br": true, "quality": "720p"}, {"hash": "", "pool": "x"}, null]});
    let rec = read_record(&raw);
    assert_eq!(rec.len(), 1);
    assert_eq!(rec[0].hash, "aabb");
    assert!(read_record(&serde_json::json!("bad")).is_empty());
}

#[test]
fn is_valid_imdb_verifica_formato() {
    assert!(is_valid_imdb("tt1234567"));
    assert!(!is_valid_imdb("tt"));
    assert!(!is_valid_imdb("tt12a45"));
    assert!(!is_valid_imdb(""));
}
