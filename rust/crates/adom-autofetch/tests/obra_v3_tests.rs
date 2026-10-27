use adom_autofetch::v3::ObraStoreV3;
use adom_core::{obra_identity, obra_key, ObraIdentityInput, ObraRecordEntry};
use adom_store::kv::NativeKv;
use serde_json::json;

fn key() -> String {
    obra_key(&obra_identity(&ObraIdentityInput {
        adapter_id: "alldebrid".into(),
        account: "a".into(),
        imdb_id: Some("tt123".into()),
        ..Default::default()
    }))
}
fn entry(hash: &str, pool: &str) -> ObraRecordEntry {
    ObraRecordEntry {
        hash: hash.into(),
        pool: pool.into(),
        br: true,
        dubbed: true,
        quality: Some("720p".into()),
        ..Default::default()
    }
}

#[test]
fn aceite_deduplica_hash_e_descarta_entradas_da_janela_expirada() {
    let kv = NativeKv::open_memory().unwrap();
    let store = ObraStoreV3::new(&kv);
    let key = key();
    kv.put_json(&key, &json!({"entries":[{"hash":"AA","pool":"br","acceptedAt":1},{"hash":"bb","pool":"seeds","acceptedAt":9500}]}), 100, 0).unwrap();
    assert!(store.commit(&key, &entry("BB", "br"), 10, 10_000).unwrap());
    let records = store.read(&key, 10_000).unwrap();
    assert_eq!(records.len(), 2); // a janela inclui a entrada em 1 ms
    assert_eq!(
        (
            records[1].hash.as_str(),
            records[1].pool.as_str(),
            records[1].accepted_at
        ),
        ("bb", "br", 10_000.0)
    );
    assert!(store
        .commit(&key, &entry("cc", "seeds"), 10, 10_001)
        .unwrap());
    assert_eq!(
        store
            .read(&key, 10_001)
            .unwrap()
            .iter()
            .map(|r| r.hash.as_str())
            .collect::<Vec<_>>(),
        ["bb", "cc"]
    );
}

#[test]
fn terminal_remove_so_o_hash_e_apaga_a_chave_quando_esvazia() {
    let kv = NativeKv::open_memory().unwrap();
    let store = ObraStoreV3::new(&kv);
    let key = key();
    store.commit(&key, &entry("AA", "br"), 100, 10).unwrap();
    store.commit(&key, &entry("BB", "seeds"), 100, 20).unwrap();
    assert!(store.forget_hash(&key, "Aa", 100, 30).unwrap());
    assert_eq!(store.read(&key, 30).unwrap()[0].hash, "bb");
    assert!(!store.forget_hash(&key, "aa", 100, 30).unwrap());
    assert!(store.forget_hash(&key, "bb", 100, 30).unwrap());
    assert!(kv.get_json(&key, 30).unwrap().is_none());
}

#[test]
fn entrada_invalida_nao_escreve_e_ttl_zero_usa_um_segundo() {
    let kv = NativeKv::open_memory().unwrap();
    let store = ObraStoreV3::new(&kv);
    let key = key();
    assert!(!store.commit("", &entry("aa", "br"), 10, 0).unwrap());
    assert!(!store.commit(&key, &entry("", "br"), 10, 0).unwrap());
    store.commit(&key, &entry("aa", "br"), 0, 0).unwrap();
    assert!(store.read(&key, 999).unwrap().len() == 1);
    assert!(store.read(&key, 1000).unwrap().is_empty());
}
