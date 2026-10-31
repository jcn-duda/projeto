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

#[test]
fn restore_soma_persistido_e_descarta_chave_desconhecida() {
    let metrics = MetaMetrics::new();
    let mut counts = BTreeMap::new();
    counts.insert(RESOLVE_TOTAL.to_string(), 10);
    counts.insert(FALLBACK_USED.to_string(), 3);
    counts.insert("meta.fallback.chave-aposentada".to_string(), 99);
    metrics.restore(counts);
    assert_eq!(metrics.get(RESOLVE_TOTAL), 10);
    assert_eq!(metrics.get(FALLBACK_USED), 3);
    assert_eq!(
        metrics.snapshot().len(),
        KEYS.len(),
        "chave aposentada não nasce no snapshot"
    );
}

#[test]
fn restore_acumula_chamadas_repetidas() {
    let metrics = MetaMetrics::new();
    let mut counts = BTreeMap::new();
    counts.insert(NATIVE_OK.to_string(), 1);
    metrics.restore(counts.clone());
    metrics.restore(counts);
    assert_eq!(metrics.get(NATIVE_OK), 2);
}
