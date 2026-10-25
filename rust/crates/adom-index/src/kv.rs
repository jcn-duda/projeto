//! `NativeKv` — KV JSON na tabela `cache` do `data/cache.db` compartilhado.
//!
//! Dono único por namespace: aqui grava o lado Rust (fila/estado do Chupim,
//! posse/proteção do AllDebrid). O Node não cria L1 nem regrava o L2 dessas
//! chaves — ele só espia pela ponte napi (leitura).
//!
//! Mesmo schema e mesmo desenho de `adom-harvest/src/store.rs`
//! (`cache(key, value, expires_at)`, WAL): TTL em segundos e o relógio entra
//! por parâmetro, nunca de dentro do store.
//!
//! Regras de expiração (as mesmas do `cache.get` do Node):
//! - `ttl_seconds <= 0` grava `expires_at = 0` = **permanente**;
//! - `expires_at > 0 && expires_at <= now_ms` = expirado: a leitura apaga a
//!   linha e devolve `None`.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection};
use serde_json::Value;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
";

/// KV JSON sobre a tabela `cache`, compartilhado com o Node e o gateway.
pub struct NativeKv {
    conn: Mutex<Connection>,
}

impl NativeKv {
    /// Abre (ou cria) o `cache.db` em `path`.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("pasta do cache.db: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir cache.db: {err}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema do cache.db: {err}"))?;
        Ok(Self::from_conn(conn))
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        Ok(Self::from_conn(conn))
    }

    fn from_conn(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// `cache.set(chave, valor, ttl)` do lado nativo: `ttl <= 0` é permanente.
    pub fn put_json(
        &self,
        key: &str,
        value: &Value,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<(), String> {
        let expires_at = expires_at_for(ttl_seconds, now_ms);
        let encoded = serde_json::to_string(value).map_err(|err| err.to_string())?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, encoded, expires_at],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Leitura dura: expirado é apagado da tabela e devolve `None`.
    pub fn get_json(&self, key: &str, now_ms: i64) -> Result<Option<Value>, String> {
        let conn = self.lock();
        let Some((raw, expires_at)) = read_row(&conn, key)? else {
            return Ok(None);
        };
        if is_expired(expires_at, now_ms) {
            forget(&conn, key)?;
            return Ok(None);
        }
        serde_json::from_str(&raw)
            .map(Some)
            .map_err(|err| format!("valor inválido em {key}: {err}"))
    }

    /// Remove a linha (`cache.forget` do Node). `false` = não havia nada.
    ///
    /// Necessário para tirar o item da fila e soltar o lease: sem isto só
    /// restaria gravar um tombstone e esperar o TTL.
    pub fn forget(&self, key: &str) -> Result<bool, String> {
        let conn = self.lock();
        let removed = conn
            .execute("DELETE FROM cache WHERE key = ?1", params![key])
            .map_err(|err| err.to_string())?;
        Ok(removed > 0)
    }

    /// Chaves vivas com o prefixo (`substr`, como o `len` do `RawCacheStore`).
    /// As expiradas que a varredura encontrar saem do banco na mesma passada:
    /// quem lista um namespace também o poda, como o `cache.keys()` do Node.
    pub fn keys_matching(&self, prefix: &str, now_ms: i64) -> Result<Vec<String>, String> {
        let conn = self.lock();
        let rows: Vec<(String, Option<i64>)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT key, expires_at FROM cache
                     WHERE substr(key, 1, length(?1)) = ?1
                     ORDER BY key",
                )
                .map_err(|err| err.to_string())?;
            let mapped = stmt
                .query_map(params![prefix], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
                })
                .map_err(|err| err.to_string())?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
        };
        let mut live = Vec::new();
        for (key, expires_at) in rows {
            if is_expired(expires_at, now_ms) {
                forget(&conn, &key)?;
            } else {
                live.push(key);
            }
        }
        Ok(live)
    }
}

/// `ttl <= 0` = permanente (`expires_at = 0`); o resto soma segundos ao relógio.
fn expires_at_for(ttl_seconds: i64, now_ms: i64) -> i64 {
    if ttl_seconds <= 0 {
        return 0;
    }
    now_ms.saturating_add(ttl_seconds.saturating_mul(1_000))
}

/// `expires_at = 0`/ausente = sem expiração; positivo e vencido = expirado.
fn is_expired(expires_at: Option<i64>, now_ms: i64) -> bool {
    matches!(expires_at, Some(ts) if ts > 0 && ts <= now_ms)
}

fn forget(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn read_row(conn: &Connection, key: &str) -> Result<Option<(String, Option<i64>)>, String> {
    let mut stmt = conn
        .prepare("SELECT value, expires_at FROM cache WHERE key = ?1")
        .map_err(|err| err.to_string())?;
    let row = stmt
        .query_row(params![key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .ok();
    Ok(row)
}

#[cfg(test)]
#[path = "kv_tests.rs"]
mod tests;
