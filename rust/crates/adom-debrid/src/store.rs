//! `debrid.db`: mesma forma do `cache.db` (`key`, `value`, `expires_at`).
//! A tabela se chama `cache` para o export ser uma cópia, não uma tradução.
//! Um namespace por prefixo; cota estoura apagando o que expira primeiro.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OpenFlags};

use crate::import::OWNED_PREFIXES;

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

/// Cotas dos namespaces que este banco passa a possuir. Os números são os de
/// `src/utils/cache-quotas.ts` — capacidade, não prazo.
pub fn default_quotas() -> &'static [(&'static str, u64)] {
    &[
        ("davail:v1:", 1000),
        ("mag:v1:", 50000),
        ("mag_meta:v1:", 1),
        ("rdc:v2:", 14000),
        ("rdq:v1:", 500),
        ("rdt:v1:", 2500),
        ("autofetch:v3:", 4000),
        ("adprot:v1:", 2000),
        ("adsub:v1:", 1000),
        ("adrm:v1:", 500),
    ]
}

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
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::open_with_quotas(path, default_quotas())
    }

    pub fn open_with_quotas(path: &Path, quotas: &[(&'static str, u64)]) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("pasta do debrid.db: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir debrid.db: {err}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema debrid.db: {err}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
            quotas: quotas.to_vec(),
            read_only: false,
        })
    }

    /// Leitor READ-ONLY do `cache.db` do Node (padrão F3.1: mesmo arquivo,
    /// mesmas chaves, Node é a fachada). O ledger `rdc:v2` do Real-Debrid
    /// mora lá; o `debrid.db` é outro arquivo e deixava todo hash `Unknown`.
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

    pub fn put_internal(&self, key: &str, value: &str, expires_at: i64) -> Result<(), String> {
        if self.read_only {
            return Err("cache.db do Node é somente leitura".into());
        }
        if !key.starts_with("__debrid:") {
            return Err("chave interna precisa do prefixo __debrid:".into());
        }
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, value, expires_at],
        )
        .map_err(|err| err.to_string())?;
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

    pub fn rows_with_prefix(&self, prefix: &str) -> Result<Vec<(String, String, i64)>, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT key, value, expires_at FROM cache
                 WHERE substr(key, 1, length(?1)) = ?1 ORDER BY key",
            )
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![prefix], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
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
    OWNED_PREFIXES
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
