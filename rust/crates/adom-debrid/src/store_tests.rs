use super::Store;

#[test]
fn ttl_esconde_expirado_e_cota_apaga_o_mais_cedo() {
    let store = Store::open_memory(&[("davail:v1:", 2)]).unwrap();
    store.put("davail:v1:a", "1", 10, 0).unwrap();
    store.put("davail:v1:b", "1", 30, 0).unwrap();
    store.put("davail:v1:c", "1", 20, 0).unwrap();
    assert!(store.get("davail:v1:a", 0).unwrap().is_none());
    assert_eq!(store.get("davail:v1:b", 0).unwrap().as_deref(), Some("1"));
    assert_eq!(store.get("davail:v1:c", 0).unwrap().as_deref(), Some("1"));
    store.put("davail:v1:b", "1", 5, 0).unwrap();
    assert!(store.get("davail:v1:b", 5).unwrap().is_none());
}

#[test]
fn recusa_namespace_alheio() {
    let store = Store::open_memory(&[("davail:v1:", 2)]).unwrap();
    let err = store.put("streams:v21:x", "1", 10, 0).unwrap_err();
    assert!(err.contains("fora dos namespaces"));
}
