use super::*;
use serde_json::json;

/// Trait do coletor BLUDV: chave alheia é no-op (log), nunca panic; erro de
/// IO do disco não derruba a coleta.
#[test]
fn trait_ignora_erro_de_io_em_vez_de_panicar() {
    let store = RawStoreHandle::open_memory().expect("store");
    let key = "raw:v1:bludv:t:Matrix";
    RawStore::set(&store, "streams:v21:x", &json!({}), 10, 1);
    assert_eq!(store.len().expect("len"), 0);
    RawStore::set(&store, key, &json!({"items": []}), 10, 1);
    assert!(RawStore::get(&store, key, 2).is_some());
}
