//! Persistência L2 da fila `harvest:v1:q` (SQLite, WAL).
//!
//! Espelha o padrão de `adom-store` / `adom-debrid::store` (rusqlite, tabela
//! `cache` com `key`/`value`/`expires_at`) e o contrato TS de
//! `harvest-queue.ts`: `load_queue` = `cache.get(QUEUE_KEY)`; `save_queue` =
//! `cache.set` (ou `forget` se vazia). O FORMATO do valor (fila + slot em voo +
//! terminais) mora em `store_document.rs`; a mutação continua em
//! [`crate::HarvestQueue`] em memória, e este store só materializa o documento.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::queue::QUEUE_KEY;

#[path = "store_document.rs"]
mod document;

pub use document::StoredQueue;

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

/// TTL default da fila (`HARVEST_ENTRY_TTL` no TS: 7 dias).
pub const DEFAULT_ENTRY_TTL_SECONDS: u64 = 7 * 24 * 3600;

/// Cópia de auditoria da fila ilegível (`<QUEUE_KEY>:corrupt`).
///
/// O JSON podre é a ÚNICA evidência do que o colhedor perdeu; fica 30 dias
/// (tempo de alguém olhar o painel) e depois o TTL expira sozinho.
pub const CORRUPT_QUEUE_KEY: &str = "harvest:v1:q:corrupt";
const CORRUPT_BACKUP_TTL_SECONDS: u64 = 30 * 24 * 3600;

/// Banco SQLite da chave única `harvest:v1:q`.
///
/// Fora do caminho `/stream` — o gateway não abre este store.
pub struct HarvestStore {
    conn: Mutex<Connection>,
    /// Veredito do `open`: arquivo podre = quarentenado (a fila antiga caiu).
    store_error: Option<String>,
}

impl HarvestStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let (conn, store_error) = open_quarantined(path)?;
        Ok(Self {
            conn: Mutex::new(conn),
            store_error,
        })
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            store_error: None,
        })
    }

    /// O `cache.db` estava podre no boot: o arquivo foi para a quarentena.
    pub fn degraded(&self) -> bool {
        self.store_error.is_some()
    }

    /// O que o `quick_check` respondeu + o destino do arquivo.
    pub fn degraded_error(&self) -> Option<&str> {
        self.store_error.as_deref()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub fn forget_queue(&self) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM cache WHERE key = ?1", params![QUEUE_KEY])
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// `cache.set(chave, valor, ttl)` das chaves auxiliares (`seen:`, `hour:`).
    pub fn put_value(
        &self,
        key: &str,
        value: &str,
        ttl_seconds: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        let expires_at = now_ms.saturating_add((ttl_seconds as i64).saturating_mul(1000));
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, value, expires_at],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// `cache.get(chave)`: expirado sai da leitura e é apagado (como o Node).
    pub fn get_value(&self, key: &str, now_ms: i64) -> Result<Option<String>, String> {
        let conn = self.lock();
        let Some((value, expires_at)) = read_row(&conn, key)? else {
            return Ok(None);
        };
        if expires_at <= now_ms {
            conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
                .map_err(|err| err.to_string())?;
            return Ok(None);
        }
        Ok(Some(value))
    }

    /// Há linha viva para `harvest:v1:q`? (diagnóstico / testes).
    pub fn has_queue(&self, now_ms: i64) -> Result<bool, String> {
        let conn = self.lock();
        let Some((_, expires_at)) = read_row(&conn, QUEUE_KEY)? else {
            return Ok(false);
        };
        Ok(expires_at > now_ms)
    }

    /// Só testes: grava JSON cru (simula L2 legado com entrada podre).
    #[cfg(test)]
    pub(crate) fn put_raw_for_test(&self, value: &str, expires_at: i64) -> Result<(), String> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![QUEUE_KEY, value, expires_at],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }
}

/// `Ok(None)` só para MISS (`QueryReturnedNoRows`); qualquer outro erro sobe.
///
/// O `.ok()` antigo tratava `SQLITE_CORRUPT` como fila vazia: o colhedor
/// "perdia" a fila em silêncio em vez de avisar.
fn read_row(conn: &Connection, key: &str) -> Result<Option<(String, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT value, expires_at FROM cache WHERE key = ?1")
        .map_err(|err| format!("ler chave do harvest store: {err}"))?;
    stmt.query_row(params![key], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })
    .map(Some)
    .or_else(|err| match err {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("ler chave do harvest store: {other}")),
    })
}

/// Copia o valor ilegível para a chave de corrupção (com TTL próprio).
fn backup_corrupt(conn: &Connection, value: &str, now_ms: i64) -> Result<(), String> {
    let expires_at =
        now_ms.saturating_add((CORRUPT_BACKUP_TTL_SECONDS as i64).saturating_mul(1000));
    conn.execute(
        "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        params![CORRUPT_QUEUE_KEY, value, expires_at],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Abre `path` com `PRAGMA quick_check`; arquivo podre vira quarentena + schema
/// novo, e o erro vai no segundo item do par (o store abre DEGRADADO).
///
/// Espelho de `adom_store::integrity::open_quarantined`: a duplicação é de
/// propósito — `adom-harvest` é o crate leve da fila e não carrega
/// `adom-store` (que puxa `adom-search`/`adom-sources`) por 40 linhas.
fn open_quarantined(path: &Path) -> Result<(Connection, Option<String>), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|err| format!("pasta do harvest store: {err}"))?;
        }
    }
    let mut conn = Connection::open(path).map_err(|err| format!("abrir harvest store: {err}"))?;
    let mut store_error = None;
    if let Err(err) = quick_check(&conn) {
        // A conexão cai antes do rename: no Windows o arquivo aberto não move.
        drop(conn);
        let quarantined = quarantine(path)?;
        store_error = Some(format!(
            "{err}; arquivo movido para {}",
            quarantined.display()
        ));
        conn = Connection::open(path).map_err(|err| format!("abrir harvest store: {err}"))?;
    }
    conn.execute_batch(SCHEMA)
        .map_err(|err| format!("schema harvest store: {err}"))?;
    Ok((conn, store_error))
}

/// `PRAGMA quick_check` só passa quando a única linha devolvida é `ok`.
fn quick_check(conn: &Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA quick_check")
        .map_err(|err| format!("quick_check: {err}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("quick_check: {err}"))?;
    let mut problems = Vec::new();
    for row in rows {
        problems.push(row.map_err(|err| format!("quick_check: {err}"))?);
    }
    if problems.len() == 1 && problems[0] == "ok" {
        return Ok(());
    }
    if problems.is_empty() {
        return Err("quick_check: nenhum resultado".to_string());
    }
    Err(format!("quick_check: {}", problems.join("; ")))
}

/// Move `<arquivo>` (e os irmãos `-wal`/`-shm`) para `<arquivo>.corrupt-<epoch>`.
fn quarantine(path: &Path) -> Result<PathBuf, String> {
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let name = path
        .file_name()
        .ok_or_else(|| format!("caminho sem nome de arquivo: {}", path.display()))?
        .to_string_lossy()
        .to_string();
    let target = path.with_file_name(format!("{name}.corrupt-{epoch}"));
    std::fs::rename(path, &target)
        .map_err(|err| format!("quarentena de {}: {err}", path.display()))?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        if sidecar.exists() {
            let mut target_sidecar = target.as_os_str().to_os_string();
            target_sidecar.push(suffix);
            let _ = std::fs::rename(&sidecar, PathBuf::from(target_sidecar));
        }
    }
    Ok(target)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod store_tests;

#[cfg(test)]
#[path = "store_intent_tests.rs"]
mod intent_tests;
