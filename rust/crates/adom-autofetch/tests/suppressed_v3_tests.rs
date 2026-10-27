use adom_autofetch::v3::{suppressed_key, SuppressedRetry, SuppressedV3};
use adom_store::kv::NativeKv;
use serde_json::json;

#[test]
fn legado_e_lista_por_conta_preservam_elegibilidade() {
    let kv = NativeKv::open_memory().unwrap();
    let store = SuppressedV3::new(&kv);
    kv.put_json(
        &suppressed_key("alldebrid", "a", "AB"),
        &json!({"id": 42, "at": 50}),
        100,
        0,
    )
    .unwrap();
    store.note("alldebrid", "b", "cd", "outra", 100, 0).unwrap();
    let records = store.list("alldebrid", "a", 1, true).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].0, "ab");
    assert_eq!(records[0].1.id, "42");
    assert_eq!(records[0].1.fails, 0);
    assert_eq!(records[0].1.next_at, 0);
}

#[test]
fn renote_e_retry_nao_renovam_a_vida_do_registro() {
    let kv = NativeKv::open_memory().unwrap();
    let store = SuppressedV3::new(&kv);
    let key = suppressed_key("alldebrid", "a", "AB");
    store.note("alldebrid", "a", "AB", "7", 1000, 0).unwrap();
    store
        .note("alldebrid", "a", "AB", "8", 1000, 100_000)
        .unwrap();
    assert_eq!(kv.remaining_seconds(&key, 100_000).unwrap(), Some(900));
    assert_eq!(
        store.retry("alldebrid", "a", "ab", 1000, 200_000).unwrap(),
        SuppressedRetry::Scheduled
    );
    let entry = store
        .read("alldebrid", "a", "ab", 200_000)
        .unwrap()
        .unwrap();
    assert_eq!(
        (entry.id.as_str(), entry.fails, entry.next_at),
        ("8", 1, 500_000)
    );
    assert_eq!(kv.remaining_seconds(&key, 200_000).unwrap(), Some(800));
    assert!(store
        .list("alldebrid", "a", 499_999, true)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.list("alldebrid", "a", 500_000, true).unwrap().len(),
        1
    );
    assert!(store
        .read("alldebrid", "a", "ab", 1_000_000)
        .unwrap()
        .is_none());
}

#[test]
fn cinco_falhas_aposentam_sem_ressuscitar_um_item_removido() {
    let kv = NativeKv::open_memory().unwrap();
    let store = SuppressedV3::new(&kv);
    store.note("torbox", "a", "hash", "id", 10_000, 1).unwrap();
    for (i, delay) in [300_000, 600_000, 1_200_000, 2_400_000].iter().enumerate() {
        assert_eq!(
            store.retry("torbox", "a", "hash", 10_000, 1).unwrap(),
            SuppressedRetry::Scheduled
        );
        let rec = store.read("torbox", "a", "hash", 1).unwrap().unwrap();
        assert_eq!(rec.fails, i as i64 + 1);
        assert_eq!(rec.next_at, delay + 1);
    }
    assert_eq!(
        store.retry("torbox", "a", "hash", 10_000, 1).unwrap(),
        SuppressedRetry::GivenUp
    );
    assert_eq!(
        store.retry("torbox", "a", "hash", 10_000, 1).unwrap(),
        SuppressedRetry::Missing
    );
    assert!(!store.forget("torbox", "a", "hash").unwrap());
}

#[test]
fn identidade_incompleta_nao_cria_registro() {
    let kv = NativeKv::open_memory().unwrap();
    let store = SuppressedV3::new(&kv);
    for (adapter, account, hash, id) in [
        ("", "a", "h", "1"),
        ("a", "", "h", "1"),
        ("a", "a", "", "1"),
        ("a", "a", "h", ""),
    ] {
        assert!(!store.note(adapter, account, hash, id, 100, 0).unwrap());
    }
    assert!(kv.keys_matching("autofetch:v3:sup:", 0).unwrap().is_empty());
}
