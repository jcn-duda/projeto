use super::*;

fn kv() -> NativeKv {
    NativeKv::new(":memory:".into()).unwrap()
}

#[test]
fn probe_roundtrip_identity_matches_node_and_ttl() {
    let kv = kv();
    let key = autofetch_v3_probe_key("series".into(), "tt123".into(), Some(2), Some(4));
    assert_eq!(
        key,
        format!("autofetch:v3:probe:{}", sha256_hex("series:tt123:2:4"))
    );
    let raw = r#"{"state":"pending","at":1000,"leaseUntil":2000}"#;
    autofetch_v3_probe_write(
        &kv,
        "series".into(),
        "tt123".into(),
        Some(2),
        Some(4),
        raw.into(),
        30,
        1000,
    )
    .unwrap();
    assert_eq!(
        autofetch_v3_probe_read(&kv, "series".into(), "tt123".into(), Some(2), Some(4), 1001)
            .unwrap()
            .as_deref(),
        Some(raw)
    );
    assert!(autofetch_v3_probe_read(
        &kv,
        "series".into(),
        "tt123".into(),
        Some(2),
        Some(4),
        31_001
    )
    .unwrap()
    .is_none());
}

#[test]
fn obra_commit_read_forget_hash_roundtrip() {
    let kv = kv();
    let key = "autofetch:v3:o:work".to_string();
    let entry = r#"{"hash":"AABB","pool":"br","title":"Obra","br":true,"dubbed":true}"#;
    assert!(autofetch_v3_obra_commit(&kv, key.clone(), entry.into(), 3600, 1000).unwrap());
    let read = autofetch_v3_obra_read(&kv, key.clone(), 1001)
        .unwrap()
        .unwrap();
    assert!(read.contains("aabb"));
    assert!(autofetch_v3_obra_forget_hash(&kv, key.clone(), "aabb".into(), 3600, 1002).unwrap());
    assert!(autofetch_v3_obra_read(&kv, key, 1003).unwrap().is_none());
}

#[test]
fn suppressed_bridge_preserves_legacy_and_retry_states() {
    let kv = kv();
    let adapter = "alldebrid".to_string();
    let account = "acct".to_string();
    let hash = "aabb".to_string();
    let key = autofetch_v3_suppressed_key(adapter.clone(), account.clone(), hash.clone());
    kv.set_json(key.clone(), r#"{"id":42,"at":1000}"#.into(), 3600, 1000)
        .unwrap();
    let read =
        autofetch_v3_suppressed_read(&kv, adapter.clone(), account.clone(), hash.clone(), 1001)
            .unwrap()
            .unwrap();
    assert!(read.contains("42"));
    assert_eq!(
        autofetch_v3_suppressed_retry(
            &kv,
            adapter.clone(),
            account.clone(),
            hash.clone(),
            3600,
            1002
        )
        .unwrap(),
        "scheduled"
    );
    for i in 0..3 {
        autofetch_v3_suppressed_retry(
            &kv,
            adapter.clone(),
            account.clone(),
            hash.clone(),
            3600,
            1003 + i,
        )
        .unwrap();
    }
    assert_eq!(
        autofetch_v3_suppressed_retry(&kv, adapter, account, hash, 3600, 1010).unwrap(),
        "given-up"
    );
}

#[test]
fn lot_snapshot_is_restart_safe_and_rejects_runtime_or_secret_fields() {
    let kv = kv();
    let search_key = "movie:tt123".to_string();
    let lot = r#"{"hashes":["aabb"],"attempts":1,"deadStreak":{},"stallStreak":{},"seasonHints":{"aabb":{"imdbId":"tt123","season":1,"episode":2,"isPack":false}},"createdAt":1000,"isSettle":false,"refusals":0,"adapterId":"torbox"}"#;
    autofetch_v3_lot_write(&kv, search_key.clone(), lot.into(), 600, 1000).unwrap();
    assert_eq!(
        autofetch_v3_lot_read(&kv, search_key.clone(), 1001)
            .unwrap()
            .as_deref(),
        Some(lot)
    );
    let with_context = lot.replace(
        "\"adapterId\":\"torbox\"",
        "\"adapterId\":\"torbox\",\"context\":{\"apiKey\":\"secret\"}",
    );
    assert!(autofetch_v3_lot_write(&kv, search_key.clone(), with_context, 600, 1002).is_err());
    assert_eq!(
        autofetch_v3_lot_keys(&kv, 1003).unwrap(),
        vec![autofetch_v3_lot_key(search_key.clone())]
    );
    assert!(autofetch_v3_lot_forget(&kv, search_key.clone()).unwrap());
    assert!(autofetch_v3_lot_read(&kv, search_key, 1004)
        .unwrap()
        .is_none());
}
