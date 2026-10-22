//! Estado do debrid: LEITOR read-only do `cache.db` do Node — é lá que mora o
//! ledger do Real-Debrid (`rdc:v2`) — mais a instância em memória dos testes.
//! Mesma forma do arquivo do Node (`key`, `value`, `expires_at`) e a mesma
//! tabela `cache`, para a leitura ser leitura, não tradução.
//!
//! O `debrid.db` da fundação ("dono" destes namespaces, alimentado pelo
//! import) saiu: era um instantâneo de uma vez só e deixava todo hash do RD
//! `Unknown` — quem escreve o arquivo compartilhado é o Node.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OpenFlags};

/// Namespaces que este banco conhece; as versões são as de
/// `src/utils/cache-keys.ts`. Guarda de escrita: `put` recusa chave de fora,
/// porque um `streams:v21:` gravado aqui seria lixo permanente.
const WRITABLE_PREFIXES: &[&str] = &[
    "davail:v1:",
    "mag:v1:",
    "mag_meta:v1:",
    "rdc:v2:",
    "rdt:v1:",
    "rdq:v1:",
    "adsub:v1:",
    "adrm:v1:",
    "adprot:v1:",
    "autofetch:v3:",
];

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
";

pub struct Store {
    conn: Mutex<Connection>,
    quotas: Vec<(&'static str, u64)>,
    /// Leitor do arquivo compartilhado com o Node (`cache.db`): `get` não
    /// apaga expirado e `put` é recusado. Sem isto o Rust seria um segundo
    /// dono do arquivo, e o L1 do Node (que não relê o disco) sobrescreveria
    /// ou apagaria a linha na próxima evicção.
    read_only: bool,
}

impl Store {
    /// Leitor READ-ONLY do `cache.db` do Node (padrão F3.1: mesmo arquivo,
    /// mesmas chaves, Node é a fachada). O ledger `rdc:v2` do Real-Debrid
    /// mora lá; o antigo `debrid.db` deixava todo hash `Unknown`.
    pub fn open_cache_db(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Err(format!("cache.db ausente: {}", path.display()));
        }
        let conn = open_readonly(path)?;
        Ok(Self {
            conn: Mutex::new(conn),
            // Sem quota: o Rust nunca evicta no arquivo do Node.
            quotas: Vec::new(),
            read_only: true,
        })
    }

    pub fn open_memory(quotas: &[(&'static str, u64)]) -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            quotas: quotas.to_vec(),
            read_only: false,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub fn get(&self, key: &str, now_ms: i64) -> Result<Option<String>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT value, expires_at FROM cache WHERE key = ?1")
            .map_err(|err| err.to_string())?;
        let row = stmt
            .query_row(params![key], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .ok();
        drop(stmt);
        let Some((value, expires_at)) = row else {
            return Ok(None);
        };
        if expires_at <= now_ms {
            // Leitor não escreve: apagar aqui seria evicção no arquivo do Node.
            if !self.read_only {
                conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
                    .map_err(|err| err.to_string())?;
            }
            return Ok(None);
        }
        Ok(Some(value))
    }

    pub fn put(&self, key: &str, value: &str, expires_at: i64, now_ms: i64) -> Result<(), String> {
        if self.read_only {
            return Err("cache.db do Node é somente leitura".into());
        }
        if !is_writable_key(key) {
            return Err(format!("chave fora dos namespaces do debrid: {key}"));
        }
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, value, expires_at],
        )
        .map_err(|err| err.to_string())?;
        if let Some(prefix) = prefix_of(key) {
            if let Some(quota) = self.quota_for(prefix) {
                enforce_quota(&conn, prefix, quota, now_ms)?;
            }
        }
        Ok(())
    }

    pub fn contains(&self, key: &str) -> Result<bool, String> {
        let conn = self.lock();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cache WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        Ok(n > 0)
    }

    fn quota_for(&self, prefix: &str) -> Option<u64> {
        self.quotas
            .iter()
            .find(|(name, _)| *name == prefix)
            .map(|(_, quota)| *quota)
    }
}

pub fn is_writable_key(key: &str) -> bool {
    prefix_of(key).is_some()
}

pub fn prefix_of(key: &str) -> Option<&'static str> {
    WRITABLE_PREFIXES
        .iter()
        .copied()
        .find(|prefix| key.starts_with(prefix))
}

fn enforce_quota(conn: &Connection, prefix: &str, quota: u64, now_ms: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM cache WHERE expires_at <= ?1 AND substr(key, 1, length(?2)) = ?2",
        params![now_ms, prefix],
    )
    .map_err(|err| err.to_string())?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cache WHERE substr(key, 1, length(?1)) = ?1",
            params![prefix],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let extra = count - quota as i64;
    if extra <= 0 {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM cache WHERE key IN (
            SELECT key FROM cache WHERE substr(key, 1, length(?1)) = ?1
            ORDER BY expires_at ASC LIMIT ?2
        )",
        params![prefix, extra],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub fn open_readonly(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| format!("abrir leitura: {err}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|err| err.to_string())?;
    Ok(conn)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;
