use adom_autofetch::v3::{ObraReservationInput, ObraReservations, ObraStoreV3};
use adom_core::{ObraIdentityInput, ObraLiveConfig, ObraRecordEntry};
use adom_store::kv::NativeKv;

fn config() -> ObraLiveConfig {
    ObraLiveConfig {
        auto_fetch_max: 1.0,
        auto_fetch_top_seeds_max: 1.0,
        auto_fetch_rare_max: 3.0,
        auto_fetch_ttl: 3600.0,
    }
}
fn candidate(pool: &str, quality: &str) -> ObraReservationInput {
    ObraReservationInput {
        identity: ObraIdentityInput {
            adapter_id: "ad".into(),
            account: "a".into(),
            imdb_id: Some("tt123".into()),
            ..Default::default()
        },
        pool: pool.into(),
        hash: "AA".into(),
        rare: false,
        slot_limit: None,
        quality: Some(quality.into()),
    }
}

#[test]
fn reserva_conta_antes_do_aceite_e_release_devolve_a_vaga() {
    let kv = NativeKv::open_memory().unwrap();
    let store = ObraStoreV3::new(&kv);
    let mut reservations = ObraReservations::default();
    let c = candidate("br", "720p");
    let first = reservations
        .reserve(&store, &c, &config(), 100)
        .unwrap()
        .unwrap();
    assert!(reservations
        .reserve(&store, &c, &config(), 101)
        .unwrap()
        .is_none());
    assert!(reservations.release(&first));
    assert!(!reservations.release(&first));
    assert!(reservations
        .reserve(&store, &c, &config(), 102)
        .unwrap()
        .is_some());
    assert!(reservations
        .reserve(&store, &c, &config(), 60_102)
        .unwrap()
        .is_some());
}

#[test]
fn overflow_de_upgrade_e_unico_e_ve_reserva_pendente() {
    let kv = NativeKv::open_memory().unwrap();
    let store = ObraStoreV3::new(&kv);
    let mut reservations = ObraReservations::default();
    let old = candidate("br", "720p");
    let first = reservations
        .reserve(&store, &old, &config(), 1)
        .unwrap()
        .unwrap();
    let upgrade = candidate("br", "1080p");
    let extra = reservations
        .reserve(&store, &upgrade, &config(), 2)
        .unwrap()
        .unwrap();
    assert!(extra.overflow);
    assert!(reservations
        .reserve(&store, &candidate("br", "2160p"), &config(), 3)
        .unwrap()
        .is_none());
    reservations.release(&first);
    reservations.release(&extra);
    store
        .commit(
            &first.key,
            &ObraRecordEntry {
                hash: "aa".into(),
                pool: "br".into(),
                quality: Some("720p".into()),
                ..Default::default()
            },
            3600,
            4,
        )
        .unwrap();
    assert!(
        reservations
            .reserve(&store, &upgrade, &config(), 5)
            .unwrap()
            .unwrap()
            .overflow
    );
}

#[test]
fn seeds_tem_cap_proprio_e_identidade_ausente_e_fail_open() {
    let kv = NativeKv::open_memory().unwrap();
    let store = ObraStoreV3::new(&kv);
    let mut reservations = ObraReservations::default();
    let br = candidate("br", "720p");
    reservations
        .reserve(&store, &br, &config(), 1)
        .unwrap()
        .unwrap();
    let mut seeds = candidate("seeds", "720p");
    seeds.slot_limit = Some(3.0);
    for _ in 0..3 {
        assert!(reservations
            .reserve(&store, &seeds, &config(), 2)
            .unwrap()
            .is_some());
    }
    assert!(reservations
        .reserve(&store, &seeds, &config(), 2)
        .unwrap()
        .is_none());
    seeds.identity.account.clear();
    assert!(reservations
        .reserve(&store, &seeds, &config(), 2)
        .unwrap()
        .unwrap()
        .key
        .is_empty());
}

#[test]
fn commit_libera_reserva_e_herda_hash_pool_e_overflow() {
    let kv = NativeKv::open_memory().unwrap();
    let store = ObraStoreV3::new(&kv);
    let mut reservations = ObraReservations::default();
    let first = reservations
        .reserve(&store, &candidate("br", "720p"), &config(), 1)
        .unwrap()
        .unwrap();
    let upgrade = reservations
        .reserve(&store, &candidate("br", "1080p"), &config(), 2)
        .unwrap()
        .unwrap();
    assert!(upgrade.overflow);
    assert!(reservations
        .commit(&store, &upgrade, &ObraRecordEntry::default(), None, 3600, 3)
        .unwrap());
    assert!(!reservations.release(&upgrade));
    let entry = &store.read(&upgrade.key, 3).unwrap()[0];
    assert_eq!(
        (entry.hash.as_str(), entry.pool.as_str(), entry.overflow),
        ("aa", "br", true)
    );
    assert!(reservations
        .commit(
            &store,
            &first,
            &ObraRecordEntry {
                hash: "bb".into(),
                ..Default::default()
            },
            Some(false),
            3600,
            4
        )
        .unwrap());
    assert!(
        !store
            .read(&first.key, 4)
            .unwrap()
            .iter()
            .find(|e| e.hash == "bb")
            .unwrap()
            .overflow
    );
}

#[test]
fn falha_no_kv_preserva_reserva_ate_expirar_ou_release() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let kv = NativeKv::open(&path).unwrap();
    let store = ObraStoreV3::new(&kv);
    let mut reservations = ObraReservations::default();
    let c = candidate("br", "720p");
    let lease = reservations
        .reserve(&store, &c, &config(), 1)
        .unwrap()
        .unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_obra BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;").unwrap();
    assert!(reservations
        .commit(&store, &lease, &ObraRecordEntry::default(), None, 3600, 2)
        .is_err());
    assert!(reservations
        .reserve(&store, &c, &config(), 3)
        .unwrap()
        .is_none());
    assert!(reservations.release(&lease));
    assert!(reservations
        .reserve(&store, &c, &config(), 4)
        .unwrap()
        .is_some());
}
