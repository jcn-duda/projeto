//! Persistência SQLite de `streams:v21`.
//!
//! Schema idêntico ao `cache.db` / `debrid.db` (`key`, `value`, `expires_at`)
//! para um dia o export/import ser cópia, não tradução. Cota = `quota_for
//! ("streams")` de `adom-core` (2000). Despejo: primeiro o que já passou da
//! graça SWR; se ainda passar da cota, o que expira mais cedo.

use std::path::Path;
use std::sync::Mutex;

use adom_core::{prefix, quota_for};
use adom_search::{StoreHit, StreamsEntry, SwrStore, MAX_TTL_SECONDS, STREAM_STALE_GRACE_SECONDS};
use rusqlite::{params, Connection};

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

/// Nome do namespace nas cotas (`QUOTAS` / `cache-quotas.ts`).
pub const STREAMS_NAMESPACE: &str = "streams";

/// Prefixo versionado vivo (`streams:v21:`).
pub fn streams_prefix() -> &'static str {
    prefix(STREAMS_NAMESPACE)
}

/// Cota L1 do namespace streams (capacidade, não TTL).
pub fn default_streams_quota() -> u64 {
    quota_for(STREAMS_NAMESPACE) as u64
}

pub fn is_streams_key(key: &str) -> bool {
    key.starts_with(streams_prefix())
}

/// Banco SQLite só do namespace `streams:v21`.
pub struct StreamsStore {
    conn: Mutex<Connection>,
    quota: u64,
}

impl StreamsStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::open_with_quota(path, default_streams_quota())
    }

    pub fn open_with_quota(path: &Path, quota: u64) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("pasta do streams store: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir streams store: {err}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema streams store: {err}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
            quota,
        })
    }

    pub fn open_memory() -> Result<Self, String> {
        Self::open_memory_with_quota(default_streams_quota())
    }

    pub fn open_memory_with_quota(quota: u64) -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            quota,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// Leitura dura: expirado = apaga e devolve `None` (como `cache.get` do TS).
    pub fn get(&self, key: &str, now_ms: u64) -> Result<Option<StreamsEntry>, String> {
        let conn = self.lock();
        let Some((value, expires_at)) = read_row(&conn, key)? else {
            return Ok(None);
        };
        if expires_at <= now_ms as i64 {
            conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
                .map_err(|err| err.to_string())?;
            return Ok(None);
        }
        Ok(Some(decode_entry(&value)?))
    }

    /// SWR: fresco / stale dentro da graça / miss + apaga além da graça.
    pub fn get_with_stale(
        &self,
        key: &str,
        grace_seconds: u64,
        now_ms: u64,
    ) -> Result<Option<StoreHit>, String> {
        let conn = self.lock();
        let Some((value, expires_at)) = read_row(&conn, key)? else {
            return Ok(None);
        };
        let expires_at = expires_at as u64;
        if now_ms > expires_at {
            let grace_ms = grace_seconds.saturating_mul(1000);
            if now_ms > expires_at.saturating_add(grace_ms) {
                conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
                    .map_err(|err| err.to_string())?;
                return Ok(None);
            }
            return Ok(Some(StoreHit {
                value: decode_entry(&value)?,
                stale: true,
            }));
        }
        Ok(Some(StoreHit {
            value: decode_entry(&value)?,
            stale: false,
        }))
    }

    /// Grava com TTL grampeado a [`MAX_TTL_SECONDS`]. Só aceita chave `streams:v21:`.
    pub fn set(
        &self,
        key: &str,
        value: &StreamsEntry,
        ttl_seconds: u64,
        now_ms: u64,
    ) -> Result<(), String> {
        if !is_streams_key(key) {
            return Err(format!(
                "chave fora do namespace streams: {key} (esperado prefixo {})",
                streams_prefix()
            ));
        }
        let ttl = ttl_seconds.min(MAX_TTL_SECONDS);
        let expires_at = now_ms.saturating_add(ttl.saturating_mul(1000)) as i64;
        let encoded = serde_json::to_string(value).map_err(|err| err.to_string())?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, encoded, expires_at],
        )
        .map_err(|err| err.to_string())?;
        enforce_quota(&conn, streams_prefix(), self.quota, now_ms as i64)?;
        Ok(())
    }

    pub fn forget(&self, key: &str) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn len(&self) -> Result<usize, String> {
        let conn = self.lock();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cache WHERE substr(key, 1, length(?1)) = ?1",
                params![streams_prefix()],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        Ok(n as usize)
    }

    pub fn is_empty(&self) -> Result<bool, String> {
        Ok(self.len()? == 0)
    }

    pub fn quota(&self) -> u64 {
        self.quota
    }
}

/// Adapter: `StreamsStore` fala a mesma lingua do `MemorySwrStore`.
/// Erro de I/O vira miss / no-op (o Orchestrator não carrega `Result` no trait).
impl SwrStore for StreamsStore {
    fn get_with_stale(&self, key: &str, grace_seconds: u64, now_ms: u64) -> Option<StoreHit> {
        StreamsStore::get_with_stale(self, key, grace_seconds, now_ms)
            .ok()
            .flatten()
    }

    fn set(&self, key: &str, value: &StreamsEntry, ttl_seconds: u64, now_ms: u64) {
        let _ = StreamsStore::set(self, key, value, ttl_seconds, now_ms);
    }

    fn forget(&self, key: &str) {
        let _ = StreamsStore::forget(self, key);
    }

    fn len(&self) -> usize {
        StreamsStore::len(self).unwrap_or(0)
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

fn decode_entry(raw: &str) -> Result<StreamsEntry, String> {
    serde_json::from_str(raw).map_err(|err| format!("StreamsEntry inválida: {err}"))
}

/// Como o `loadFromDisk` do TS: fora da graça SWR some; dentro da cota, o que
/// expira primeiro cede lugar.
fn enforce_quota(conn: &Connection, prefix: &str, quota: u64, now_ms: i64) -> Result<(), String> {
    let grace_ms = (STREAM_STALE_GRACE_SECONDS as i64).saturating_mul(1000);
    let hard_cut = now_ms.saturating_sub(grace_ms);
    conn.execute(
        "DELETE FROM cache WHERE expires_at <= ?1 AND substr(key, 1, length(?2)) = ?2",
        params![hard_cut, prefix],
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

#[cfg(test)]
#[path = "streams_tests.rs"]
mod streams_tests;
