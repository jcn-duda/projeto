use super::*;
use serde_json::json;

fn key(query: &str) -> String {
    format!("raw:v1:bludv:t:{query}")
}

#[test]
fn roundtrip_respeita_ttl_e_formato_do_node() {
    let store = RawCacheStore::open_memory_with_quota(4).expect("store");
    assert_eq!(raw_prefix(), "raw:v1:");
    let value = json!({
        "items": [{
            "title": "Matrix 1999 [1080p WEB-DL DUBLADO]",
            "magnet": "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "seeders": 1.0,
            "size": 1000.0,
            "tracker": "BLUDV",
            "audio": "dublado",
            "isBr": true
        }]
    });
    store
        .set_raw(&key("Matrix"), &value, 10, 1_000)
        .expect("set");
    assert_eq!(
        store.get_raw(&key("Matrix"), 1_000).expect("get"),
        Some(value.clone())
    );
    // Dentro do TTL ainda vale (expira em 11s).
    assert!(store
        .get_raw(&key("Matrix"), 10_999)
        .expect("get")
        .is_some());
    // Vencido: miss e a linha some.
    assert_eq!(store.get_raw(&key("Matrix"), 11_000).expect("get"), None);
    assert_eq!(store.len().expect("len"), 0);
}

#[test]
fn cota_despeja_o_que_expira_primeiro() {
    let store = RawCacheStore::open_memory_with_quota(2).expect("store");
    store
        .set_raw(&key("curta"), &json!({"items": []}), 5, 1_000)
        .expect("set curta");
    store
        .set_raw(&key("longa"), &json!({"items": []}), 60, 1_000)
        .expect("set longa");
    store
        .set_raw(&key("nova"), &json!({"items": []}), 60, 1_001)
        .expect("set nova");
    assert_eq!(store.len().expect("len"), 2);
    assert!(
        store.get_raw(&key("curta"), 1_002).expect("get").is_none(),
        "a de menor expires_at cedeu lugar"
    );
    assert!(store.get_raw(&key("nova"), 1_002).expect("get").is_some());
    // Expiração do namespace limpa as vencidas sem tocar em outro prefixo.
    assert_eq!(
        store.get_raw(&key("nova"), 80_000).expect("get"),
        None,
        "TTL de 60s venceu"
    );
}

#[test]
fn recusa_chave_de_outro_namespace() {
    let store = RawCacheStore::open_memory().expect("store");
    let err = store
        .set_raw("streams:v21:abc", &json!({"items": []}), 10, 0)
        .expect_err("namespace alheio");
    assert!(err.contains("fora do namespace raw"));
    assert!(store
        .set_raw("raw:v1:x", &json!({"items": []}), 0, 0)
        .is_ok());
    assert_eq!(store.len().expect("len"), 0, "ttl 0 não grava");
}

#[test]
fn clear_all_apaga_somente_o_namespace_raw() {
    let store = RawCacheStore::open_memory_with_quota(4).expect("store");
    store
        .set_raw(&key("a"), &json!({"items": []}), 60, 1_000)
        .expect("set a");
    store
        .set_raw("raw:v1:jackett:x:movie:q", &json!({"items": []}), 60, 1_000)
        .expect("set jackett");
    // Linha de outro namespace no MESMO arquivo: o clear não pode alcançá-la.
    let conn = store.conn.lock().unwrap_or_else(|err| err.into_inner());
    conn.execute(
        "INSERT INTO cache (key, value, expires_at) VALUES ('streams:v21:x', '{}', 9999999999999)",
        [],
    )
    .expect("insere linha alheia");
    drop(conn);
    assert_eq!(store.len().expect("len"), 2);
    assert_eq!(store.clear_all().expect("clear"), 2);
    assert_eq!(store.len().expect("len"), 0);
    let conn = store.conn.lock().unwrap_or_else(|err| err.into_inner());
    let restante: i64 = conn
        .query_row("SELECT COUNT(*) FROM cache", [], |row| row.get(0))
        .expect("conta");
    drop(conn);
    assert_eq!(restante, 1, "a linha de outro namespace continua");
}
