use super::*;

#[test]
fn snapshot_expoe_todas_as_chaves_zeradas() {
    let metrics = IndexMetrics::new();
    let snapshot = metrics.snapshot();
    for key in [
        LOOKUP,
        HIT,
        PARTIAL,
        MISS,
        GAP,
        SERVED,
        RECORDED,
        BANK_MARKED,
        INSTANT,
        BR_GAP,
        EFFECTS,
        SHADOW_COMPARED,
        SHADOW_DIVERGENCE,
        BANK_SHADOW_COMPARED,
    ] {
        assert_eq!(snapshot.get(key), Some(&0), "{key} zerada no snapshot");
    }
    assert_eq!(snapshot.len(), KEYS.len());
}

#[test]
fn incrementa_e_satura() {
    let metrics = IndexMetrics::new();
    metrics.inc(MISS, 2);
    metrics.inc(MISS, 0);
    assert_eq!(metrics.get(MISS), 2);
    metrics.inc(MISS, u64::MAX);
    assert_eq!(metrics.get(MISS), u64::MAX);
}
