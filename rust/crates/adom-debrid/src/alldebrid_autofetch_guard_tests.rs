use super::*;

#[test]
fn distingue_marca_viva_expirada_e_conta() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)").unwrap();
    conn.execute(
        "INSERT INTO cache VALUES (?1, '{}', ?2)",
        params![adrm_key("conta", "ABCD"), 1001],
    )
    .unwrap();
    assert!(read_adrm_block(&path, "conta", "abcd", 1000).unwrap());
    assert!(!read_adrm_block(&path, "conta", "abcd", 1001).unwrap());
    assert!(!read_adrm_block(&path, "outra", "abcd", 1000).unwrap());
}

#[test]
fn recusa_banco_ausente_tabela_ausente_e_linha_malformada() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("ausente.db");
    assert!(read_adrm_block(&missing, "conta", "hash", 0).is_err());
    assert!(!missing.exists());
    let path = dir.path().join("cache.db");
    let conn = Connection::open(&path).unwrap();
    assert!(read_adrm_block(&path, "conta", "hash", 0).is_err());
    conn.execute_batch("CREATE TABLE cache (key TEXT PRIMARY KEY, expires_at TEXT NOT NULL)")
        .unwrap();
    conn.execute(
        "INSERT INTO cache VALUES (?1, 'inválido')",
        params![adrm_key("conta", "hash")],
    )
    .unwrap();
    assert!(read_adrm_block(&path, "conta", "hash", 0).is_err());
    assert!(read_adrm_block(&path, "", "hash", 0).is_err());
}
