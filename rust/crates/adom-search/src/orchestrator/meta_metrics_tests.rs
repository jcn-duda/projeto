use super::*;

#[test]
fn snapshot_expoe_todas_as_chaves_zeradas() {
    let metrics = MetaMetrics::new();
    let snapshot = metrics.snapshot();
    for key in [
        RESOLVE_TOTAL,
        NATIVE_OK,
        NATIVE_INCOMPLETE,
        NATIVE_ERROR,
        FALLBACK_USED,
        FALLBACK_EMPTY,
        FALLBACK_ERROR,
    ] {
        assert_eq!(snapshot.get(key), Some(&0), "{key} zerada no snapshot");
    }
    assert_eq!(snapshot.len(), KEYS.len());
}

#[test]
fn incrementa_e_satura() {
    let metrics = MetaMetrics::new();
    metrics.inc(NATIVE_INCOMPLETE, 2);
    metrics.inc(NATIVE_INCOMPLETE, 0);
    assert_eq!(metrics.get(NATIVE_INCOMPLETE), 2);
    metrics.inc(NATIVE_INCOMPLETE, u64::MAX);
    assert_eq!(metrics.get(NATIVE_INCOMPLETE), u64::MAX);
}
