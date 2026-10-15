use std::path::PathBuf;

use rusqlite::Connection;

use super::{export_owned, import_once};

fn cache_with(path: &PathBuf, rows: &[(&str, &str, i64)]) {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );",
    )
    .unwrap();
    for (key, value, expires_at) in rows {
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)",
            (key, value, expires_at),
        )
        .unwrap();
    }
}

#[test]
fn importa_so_prefixo_dono_uma_vez() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("cache.db");
    let debrid = dir.path().join("debrid.db");
    let future = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64)
        + 60_000;
    cache_with(
        &cache,
        &[
            ("davail:v1:h", "1", future),
            ("streams:v21:obra", "lista", future),
            ("davail:v1:velho", "0", 1),
        ],
    );
    let first = import_once(&debrid, &cache).unwrap();
    assert!(!first.already);
    assert_eq!(first.copied, 1);
    let again = import_once(&debrid, &cache).unwrap();
    assert!(again.already);
    assert_eq!(again.copied, 0);

    let dest = dir.path().join("cache-out.db");
    let copied = export_owned(&debrid, &dest).unwrap();
    assert_eq!(copied, 1);
    let conn = Connection::open(&dest).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cache WHERE key = 'streams:v21:obra'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
    let value: String = conn
        .query_row(
            "SELECT value FROM cache WHERE key = 'davail:v1:h'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(value, "1");
}

#[test]
fn sem_cache_nao_grava_marcador() {
    let dir = tempfile::tempdir().unwrap();
    let debrid = dir.path().join("debrid.db");
    let missing = dir.path().join("ausente.db");
    let report = import_once(&debrid, &missing).unwrap();
    assert!(!report.already);
    let second = import_once(&debrid, &missing).unwrap();
    assert!(!second.already);
}
