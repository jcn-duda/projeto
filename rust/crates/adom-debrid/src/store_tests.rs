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

#[test]
fn leitor_do_cache_db_nao_escreve_nem_apaga_expirado() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    {
        // Schema do Node (`src/utils/cache-db-open.ts`), sem nenhuma tabela a mais.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE cache (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL,
                 expires_at INTEGER NOT NULL
             );
             INSERT INTO cache VALUES ('rdc:v2:hit', '{\"s\":\"hit\"}', 100);
             INSERT INTO cache VALUES ('rdc:v2:velho', '{\"s\":\"miss\"}', 1);",
        )
        .unwrap();
    }
    let store = Store::open_cache_db(&path).unwrap();
    assert_eq!(
        store.get("rdc:v2:hit", 0).unwrap().as_deref(),
        Some("{\"s\":\"hit\"}")
    );
    // Expirado sai da leitura, mas continua no arquivo: quem evicta é o Node.
    assert!(store.get("rdc:v2:velho", 5).unwrap().is_none());
    assert!(store.contains("rdc:v2:velho").unwrap());
    assert!(store.put("rdc:v2:hit", "x", 10, 0).is_err());
}
