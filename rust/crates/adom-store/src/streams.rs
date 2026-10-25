//! Persistência SQLite de `streams:v21`.
//!
//! Schema idêntico ao `cache.db` / `debrid.db` (`key`, `value`, `expires_at`)
//! para um dia o export/import ser cópia, não tradução. Cota = `quota_for
//! ("streams")` de `adom-core` (2000). Despejo: primeiro o que já passou da
//! graça SWR; se ainda passar da cota, o que expira mais cedo.

use std::path::Path;
use std::sync::Mutex;

use adom_core::{prefix, quota_for};
use adom_search::{StoreHit, StreamsEntry, SwrStore, STREAM_STALE_GRACE_SECONDS};
use rusqlite::{params, Connection};

use crate::integrity::{self, OpenReport};

#[path = "streams_trace.rs"]
mod trace;

pub use trace::TraceHit;

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
    /// Veredito do `open`: arquivo podre = quarentenado (o cache antigo caiu).
    integrity: OpenReport,
}

impl StreamsStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        Self::open_with_quota(path, default_streams_quota())
    }

    /// Abre com `quick_check`: arquivo corrompido vai para `<arquivo>.corrupt-<epoch>`
    /// e o schema nasce de novo (ver [`crate::integrity`]).
    pub fn open_with_quota(path: &Path, quota: u64) -> Result<Self, String> {
        let (conn, integrity) = integrity::open_quarantined(path, SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
            quota,
            integrity,
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
            integrity: OpenReport::healthy(),
        })
    }

    /// O arquivo estava podre no boot e foi quarentenado (o store roda vazio).
    pub fn degraded(&self) -> bool {
        self.integrity.degraded
    }

    /// Por que degradou — `None` quando o arquivo era íntegro.
    pub fn degraded_error(&self) -> Option<&str> {
        self.integrity.error.as_deref()
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

    /// Grava a entrada com o TTL decidido pelo chamador (`commit_decision`). Só aceita chave `streams:v21:`.
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
        let expires_at = now_ms.saturating_add(ttl_seconds.saturating_mul(1000)) as i64;
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

    /// Apaga TODO o namespace (`clear-cache` do painel). Devolve quantas linhas
    /// saíram — é o número que o Node relata ao operador.
    pub fn clear_all(&self) -> Result<usize, String> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM cache WHERE substr(key, 1, length(?1)) = ?1",
            params![streams_prefix()],
        )
        .map_err(|err| err.to_string())
    }

    /// Apaga as chaves de UMA obra no formato
    /// `<prefixo><movie|series>:<tt…>[:S:E]:<scope>` — o espelho de
    /// `invalidateStreamsForObra` do Node (`src/utils/br-gap.ts`). O token
    /// `tt\d+` é o primeiro segmento depois do tipo, então `:tt1230` não colide
    /// com `:tt123`.
    pub fn invalidate_for_obra(&self, imdb_id: &str) -> Result<usize, String> {
        let target = imdb_id.trim().to_ascii_lowercase();
        if !is_imdb_id(&target) {
            return Err(format!("imdbId inválido: {imdb_id}"));
        }
        let conn = self.lock();
        let prefix = streams_prefix();
        let mut stmt = conn
            .prepare("SELECT key FROM cache WHERE substr(key, 1, length(?1)) = ?1")
            .map_err(|err| err.to_string())?;
        let keys: Vec<String> = stmt
            .query_map(params![prefix], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .filter_map(Result::ok)
            .filter(|key| obra_id_of(key).is_some_and(|id| id == target))
            .collect();
        let mut removed = 0;
        for key in keys {
            removed += conn
                .execute("DELETE FROM cache WHERE key = ?1", params![key])
                .map_err(|err| err.to_string())?;
        }
        Ok(removed)
    }

    /// Apaga as chaves cuja ENTRADA menciona o hash. Serve ao `/resolve`: o
    /// item resolvido perde `infoHash` (a URL relativa de `/resolve/<hash>` é o
    /// que sobra), então a varredura é textual no valor, em minúsculas (hex).
    pub fn invalidate_for_hash(&self, hash: &str) -> Result<usize, String> {
        let target = hash.trim().to_ascii_lowercase();
        if target.len() != 40 || !target.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("hash inválido: {hash}"));
        }
        let conn = self.lock();
        conn.execute(
            "DELETE FROM cache WHERE substr(key, 1, length(?1)) = ?1
             AND instr(lower(value), ?2) > 0",
            params![streams_prefix(), target],
        )
        .map_err(|err| err.to_string())
    }

    /// Apaga as chaves que terminam no sufixo (escopo “instalação” do painel:
    /// `:<streamsCacheScope>`). Sufixo vazio = limpar tudo.
    pub fn clear_by_suffix(&self, suffix: &str) -> Result<usize, String> {
        if suffix.is_empty() {
            return self.clear_all();
        }
        let conn = self.lock();
        conn.execute(
            "DELETE FROM cache WHERE substr(key, 1, length(?1)) = ?1
             AND substr(key, -length(?2)) = ?2",
            params![streams_prefix(), suffix],
        )
        .map_err(|err| err.to_string())
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
/// Erro de I/O vira miss / no-op (o Orchestrator não carrega `Result` no trait),
/// sempre com log — silêncio aqui já escondeu corrupção de banco.
impl SwrStore for StreamsStore {
    fn get_with_stale(&self, key: &str, grace_seconds: u64, now_ms: u64) -> Option<StoreHit> {
        match StreamsStore::get_with_stale(self, key, grace_seconds, now_ms) {
            Ok(hit) => hit,
            // O trait não carrega `Result`: o miss é o contrato, mas erro de
            // I/O/corrupção NÃO pode sumir em silêncio (era o `.ok()`).
            Err(err) => {
                eprintln!("[gateway] streams store: leitura falhou ({err}); seguindo sem cache");
                None
            }
        }
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

/// `Ok(None)` só para MISS (`QueryReturnedNoRows`); qualquer outro erro sobe.
///
/// O `.ok()` antigo engolia `SQLITE_CORRUPT`/`no such table` como se a chave
/// não existisse — cache vazio silencioso, sem log e sem pista.
pub(crate) fn read_row(conn: &Connection, key: &str) -> Result<Option<(String, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT value, expires_at FROM cache WHERE key = ?1")
        .map_err(|err| format!("ler chave do streams store: {err}"))?;
    let row = stmt
        .query_row(params![key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("ler chave do streams store: {other}")),
        });
    row
}

/// `tt` + dígitos (o mesmo `/^tt\d+$/` do Node).
fn is_imdb_id(id: &str) -> bool {
    id.strip_prefix("tt")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

/// Obra (imdbId) de uma chave `streams:v21:<movie|series>:<tt…>[:…]:…`.
/// `None` = chave fora do formato (não é deste filtro).
fn obra_id_of(key: &str) -> Option<&str> {
    let rest = key.strip_prefix(streams_prefix())?;
    let (kind, after) = rest.split_once(':')?;
    if kind != "movie" && kind != "series" {
        return None;
    }
    let id = after.split(':').next()?;
    is_imdb_id(id).then_some(id)
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
