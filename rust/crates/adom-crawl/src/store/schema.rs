//! DDL e migração do `crawl.db`.
//!
//! Port Rust do TypeScript `utils/crawl-store-migrate.ts`. Três tabelas:
//! `crawl_url` (fila de trabalho), `crawl_run` (rodadas do motor) e
//! `crawl_state` (estado durável por site). Todas idempotentes via
//! `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.

/// DDL da tabela principal de URLs. Chave composta `(site, url_key)` para
/// a fila sobreviver à troca de domínio do site (Fase 8).
pub const CRAWL_URL_DDL: &str = "\
CREATE TABLE IF NOT EXISTS crawl_url (
    site      TEXT    NOT NULL,
    url       TEXT    NOT NULL,
    url_key   TEXT    NOT NULL DEFAULT '',
    lastmod   TEXT    NOT NULL DEFAULT '',
    kind      TEXT    NOT NULL DEFAULT 'movie',
    status    TEXT    NOT NULL DEFAULT 'pending',
    imdb      TEXT,
    tries     INTEGER NOT NULL DEFAULT 0,
    next_at   INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER NOT NULL DEFAULT 0,
    releases  INTEGER NOT NULL DEFAULT 0,
    error     TEXT    NOT NULL DEFAULT '',
    progress  TEXT    NOT NULL DEFAULT '',
    added_at  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site, url_key)
)";

/// Índice para o scheduler: busca por `(site, status, next_at)` — URLs due.
pub const CRAWL_URL_DUE_INDEX: &str = "\
CREATE INDEX IF NOT EXISTS crawl_url_due ON crawl_url (site, status, next_at)";

/// Rodadas do motor de crawl. Cada `start_run` gera uma linha; `finish_run`
/// grava contadores JSON.
pub const CRAWL_RUN_DDL: &str = "\
CREATE TABLE IF NOT EXISTS crawl_run (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    site        TEXT    NOT NULL,
    phase       TEXT    NOT NULL DEFAULT '',
    cursor_val  TEXT    NOT NULL DEFAULT '',
    started_at  INTEGER NOT NULL DEFAULT 0,
    finished_at INTEGER NOT NULL DEFAULT 0,
    counters    TEXT    NOT NULL DEFAULT '{}'
)";

/// Índice para listar rodadas por site.
pub const CRAWL_RUN_SITE_INDEX: &str = "\
CREATE INDEX IF NOT EXISTS crawl_run_site ON crawl_run (site, started_at)";

/// Estado durável por site (pares chave/valor). Usado para cursor de paginação,
/// última data processada, etc.
pub const CRAWL_STATE_DDL: &str = "\
CREATE TABLE IF NOT EXISTS crawl_state (
    site       TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (site, key)
)";

/// Executa todas as migrações (cria tabelas e índices se não existem).
/// Idempotente: pode ser chamado múltiplas vezes sem efeito colateral.
pub fn migrate(conn: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    // SQLite aceita múltiplos statements separados por `;` no mesmo `execute`,
    // mas o `rusqlite::Connection::execute_batch` é o mais adequado para DDL
    // sem parâmetros.
    conn.execute_batch(CRAWL_URL_DDL)?;
    conn.execute_batch(CRAWL_URL_DUE_INDEX)?;
    conn.execute_batch(CRAWL_RUN_DDL)?;
    conn.execute_batch(CRAWL_RUN_SITE_INDEX)?;
    conn.execute_batch(CRAWL_STATE_DDL)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `migrate()` cria as 3 tabelas sem erro e é idempotente.
    #[test]
    fn migrate_cria_tabelas_idempotente() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // Primeira execução: cria tudo.
        migrate(&conn).expect("primeira migrate deve funcionar");
        // Segunda execução: idempotente, sem erro.
        migrate(&conn).expect("segunda migrate deve ser idempotente");

        // Verifica que as 3 tabelas existem via sqlite_master.
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            tables.contains(&"crawl_url".to_string()),
            "crawl_url deve existir"
        );
        assert!(
            tables.contains(&"crawl_run".to_string()),
            "crawl_run deve existir"
        );
        assert!(
            tables.contains(&"crawl_state".to_string()),
            "crawl_state deve existir"
        );
    }

    /// O índice `crawl_url_due` é criado corretamente.
    #[test]
    fn migrate_cria_indice_due() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();

        let indices: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'crawl_%'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(indices.contains(&"crawl_url_due".to_string()));
    }
}
