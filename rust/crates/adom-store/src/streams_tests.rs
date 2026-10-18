use super::{
    default_streams_quota, is_streams_key, streams_prefix, StreamsStore, STREAMS_NAMESPACE,
};
use adom_search::{StoreHit, StreamItem, StreamsEntry, SwrStore, STREAM_STALE_GRACE_SECONDS};

fn playable() -> StreamsEntry {
    StreamsEntry {
        streams: vec![StreamItem {
            info_hash: Some("0123456789abcdef0123456789abcdef01234567".into()),
            ..StreamItem::default()
        }],
        partial: false,
        debrid_known: Some(true),
        ..Default::default()
    }
}

fn key(suffix: &str) -> String {
    format!("{}{suffix}", streams_prefix())
}

#[test]
fn prefixo_e_cota_vem_do_core() {
    assert_eq!(streams_prefix(), "streams:v21:");
    assert_eq!(STREAMS_NAMESPACE, "streams");
    assert_eq!(default_streams_quota(), 2_000);
    assert!(is_streams_key(&key("movie:tt1:abc")));
    assert!(!is_streams_key("davail:v1:x"));
}

#[test]
fn get_set_roundtrip_e_get_duro_apaga_expirado() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let k = key("a");
    store.set(&k, &playable(), 60, 1_000).unwrap();
    let hit = store.get(&k, 2_000).unwrap().expect("fresco");
    assert_eq!(hit.debrid_known, Some(true));
    assert_eq!(hit.streams.len(), 1);

    // TTL 60s: vence em 61_000. get duro apaga.
    assert!(store.get(&k, 61_001).unwrap().is_none());
    assert_eq!(store.len().unwrap(), 0);
}

#[test]
fn get_with_stale_serve_dentro_da_graca() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let k = key("b");
    store.set(&k, &playable(), 60, 1_000).unwrap();

    let fresh = store
        .get_with_stale(&k, STREAM_STALE_GRACE_SECONDS, 30_000)
        .unwrap()
        .expect("fresco");
    assert!(!fresh.stale);

    let stale = store
        .get_with_stale(&k, STREAM_STALE_GRACE_SECONDS, 200_000)
        .unwrap()
        .expect("stale");
    assert!(stale.stale);
    assert_eq!(store.len().unwrap(), 1, "stale não apaga");

    // Um ms além da graça: miss + apaga.
    let past = 1_000 + 60_000 + STREAM_STALE_GRACE_SECONDS * 1000 + 1;
    assert!(store
        .get_with_stale(&k, STREAM_STALE_GRACE_SECONDS, past)
        .unwrap()
        .is_none());
    assert_eq!(store.len().unwrap(), 0);
}

#[test]
fn ttl_respeita_decisao_sem_teto_fixo() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let k_completa = key("ttl_completa");
    store.set(&k_completa, &playable(), 900, 1_000).unwrap();
    // Lista completa sobrevive além de 60s (ex.: aos 61s e aos 899s ainda serve sem stale com graça 0).
    assert!(store
        .get_with_stale(&k_completa, 0, 1_000 + 61_000)
        .unwrap()
        .is_some());
    assert!(store
        .get_with_stale(&k_completa, 0, 1_000 + 899_000)
        .unwrap()
        .is_some());
    // Após 900s, com graça 0 expira.
    assert!(store
        .get_with_stale(&k_completa, 0, 1_000 + 900_001)
        .unwrap()
        .is_none());

    // Parcial expira em 60s quando gravada com ttl de 60s.
    let k_parcial = key("ttl_parcial");
    let mut parcial = playable();
    parcial.partial = true;
    store.set(&k_parcial, &parcial, 60, 1_000).unwrap();
    assert!(store
        .get_with_stale(&k_parcial, 0, 1_000 + 60_000)
        .unwrap()
        .is_some());
    assert!(store
        .get_with_stale(&k_parcial, 0, 1_000 + 60_001)
        .unwrap()
        .is_none());
}

#[test]
fn recusa_namespace_alheio() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let err = store.set("davail:v1:x", &playable(), 60, 0).unwrap_err();
    assert!(err.contains("fora do namespace"));
}

#[test]
fn cota_apaga_o_que_expira_primeiro() {
    let store = StreamsStore::open_memory_with_quota(2).unwrap();
    store.set(&key("a"), &playable(), 10, 0).unwrap(); // expira 10_000
    store.set(&key("b"), &playable(), 30, 0).unwrap(); // expira 30_000
    store.set(&key("c"), &playable(), 20, 0).unwrap(); // expira 20_000 → empurra a
    assert!(store.get(&key("a"), 0).unwrap().is_none());
    assert!(store.get(&key("b"), 0).unwrap().is_some());
    assert!(store.get(&key("c"), 0).unwrap().is_some());
    assert_eq!(store.len().unwrap(), 2);
}

#[test]
fn swr_store_trait_sobre_sqlite() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let as_trait: &dyn SwrStore = &store;
    let k = key("trait");
    as_trait.set(&k, &playable(), 60, 1_000);
    let hit: StoreHit = as_trait
        .get_with_stale(&k, STREAM_STALE_GRACE_SECONDS, 2_000)
        .expect("hit via trait");
    assert!(!hit.stale);
    assert_eq!(as_trait.len(), 1);
    as_trait.forget(&k);
    assert_eq!(as_trait.len(), 0);
}

#[test]
fn arquivo_temp_abre_e_persiste() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("streams.db");
    {
        let store = StreamsStore::open_with_quota(&path, 10).unwrap();
        store.set(&key("disk"), &playable(), 60, 1_000).unwrap();
        assert_eq!(store.quota(), 10);
    }
    let reopened = StreamsStore::open_with_quota(&path, 10).unwrap();
    let entry = reopened
        .get(&key("disk"), 2_000)
        .unwrap()
        .expect("persistiu");
    assert_eq!(entry.debrid_known, Some(true));
}
