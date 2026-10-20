//! Persistência SQLite do namespace `raw:v1` — o MESMO `cache.db` do Node.
//!
//! O gateway roda o coletor BLUDV nativo, mas o cache bruto continua sendo o do
//! Node (`RAW_CACHE_*`): a chave (`raw:v1:bludv:d|t:<q>`) e o valor
//! (`{"items":[…]}`) são os mesmos, e o schema da tabela é o do `cache-db.ts`
//! (`key`, `value`, `expires_at`). Quem lê/escreve é só o caminho VIVO; a sombra
//! nunca recebe este store.
//!
//! Cota = `quota_for("raw")` (800) e despejo do que expira primeiro — a mesma
//! régua do `loadFromDisk`/`enforceQuota` do Node. O store NÃO apaga chaves de
//! outros namespaces.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use adom_core::{prefix, quota_for};
use adom_sources::RawStore;
use rusqlite::{params, Connection};
use serde_json::Value;

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

/// Prefixo versionado vivo (`raw:v1:`).
pub fn raw_prefix() -> &'static str {
    prefix("raw")
}

pub fn is_raw_key(key: &str) -> bool {
    key.starts_with(raw_prefix())
}

/// Cota L1 do namespace raw (capacidade, não TTL).
pub fn default_raw_quota() -> u64 {
    quota_for("raw") as u64
}

/// Banco SQLite do `raw:v1` (compartilhado com o `cache.db` do Node).
pub struct RawCacheStore {
    conn: Mutex<Connection>,
    quota: u64,
}

impl RawCacheStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::open_with_quota(path, default_raw_quota())
    }

    pub fn open_with_quota(path: &Path, quota: u64) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("pasta do raw store: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir raw store: {err}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema raw store: {err}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
            quota,
        })
    }

    pub fn open_memory() -> Result<Self, String> {
        Self::open_memory_with_quota(default_raw_quota())
    }

    pub fn open_memory_with_quota(quota: u64) -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            quota,
        })
    }

    /// `CACHE_PERSIST=false` desliga o disco (`cache.ts` do Node). O caminho é
    /// `CACHE_DB_PATH`, default `data/cache.db` (volume `docker-data/addon`).
    pub fn from_env() -> Result<Self, String> {
        if !cache_persist() {
            eprintln!("[gateway] CACHE_PERSIST=false; raw:v1 só em memória");
            return Self::open_memory();
        }
        Self::open(&cache_db_path())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn get_raw(&self, key: &str, now_ms: i64) -> Result<Option<Value>, String> {
        let conn = self.lock();
        let row = read_row(&conn, key)?;
        let Some((raw, expires_at)) = row else {
            return Ok(None);
        };
        if expires_at <= now_ms {
            conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
                .map_err(|err| err.to_string())?;
            return Ok(None);
        }
        serde_json::from_str(&raw)
            .map(Some)
            .map_err(|err| format!("raw:v1 inválido: {err}"))
    }

    fn set_raw(
        &self,
        key: &str,
        value: &Value,
        ttl_seconds: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        if !is_raw_key(key) {
            return Err(format!(
                "chave fora do namespace raw: {key} (esperado prefixo {})",
                raw_prefix()
            ));
        }
        if ttl_seconds == 0 {
            return Ok(());
        }
        let expires_at = now_ms.saturating_add(ttl_seconds.saturating_mul(1_000) as i64);
        let encoded = serde_json::to_string(value).map_err(|err| err.to_string())?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, encoded, expires_at],
        )
        .map_err(|err| err.to_string())?;
        enforce_quota(&conn, raw_prefix(), self.quota, now_ms)?;
        Ok(())
    }

    pub fn len(&self) -> Result<usize, String> {
        let conn = self.lock();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cache WHERE substr(key, 1, length(?1)) = ?1",
                params![raw_prefix()],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        Ok(n as usize)
    }

    /// Par do `len` (Clippy): o store vazio é o caso normal antes do primeiro
    /// `raw:v1` gravado.
    pub fn is_empty(&self) -> Result<bool, String> {
        Ok(self.len()? == 0)
    }

    pub fn quota(&self) -> u64 {
        self.quota
    }
}

impl RawStore for RawCacheStore {
    fn get(&self, key: &str, now_ms: i64) -> Option<Value> {
        self.get_raw(key, now_ms).ok().flatten()
    }

    fn set(&self, key: &str, value: &Value, ttl_seconds: u64, now_ms: i64) {
        if let Err(err) = self.set_raw(key, value, ttl_seconds, now_ms) {
            eprintln!("[gateway] raw:v1 não gravou: {err}");
        }
    }
}

fn read_row(conn: &Connection, key: &str) -> Result<Option<(String, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT value, expires_at FROM cache WHERE key = ?1")
        .map_err(|err| err.to_string())?;
    let row = stmt
        .query_row(params![key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .ok();
    Ok(row)
}

/// Fora do TTL some; acima da cota o que expira primeiro cede lugar.
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

/// `String(process.env.CACHE_PERSIST || 'true') !== 'false'` do `cache.ts`:
/// QUALQUER valor diferente de "false" mantém o disco (inclusive vazio).
pub(crate) fn cache_persist() -> bool {
    std::env::var("CACHE_PERSIST")
        .map(|raw| !raw.trim().eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

/// `CACHE_DB_PATH` (default `data/cache.db`), compartilhado com o Node.
pub(crate) fn cache_db_path() -> PathBuf {
    std::env::var("CACHE_DB_PATH")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/cache.db"))
}

#[cfg(test)]
#[path = "raw_tests.rs"]
mod raw_tests;
