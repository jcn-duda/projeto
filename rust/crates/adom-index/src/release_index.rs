//! Persistência SQLite do índice de releases (`idx:v14`) — o MESMO `cache.db`
//! do Node, no formato EXATO do `src/utils/release-index.ts`.
//!
//! Por que nativo: a leitura do índice é o primeiro passo da busca (a resposta
//! sai dele quando a obra está coberta) e a escrita é o que alimenta o colhedor
//! entre buscas. O Rust lê/grava as mesmas chaves (`idx:v14:<imdb>[:S<n>][E<n>]`)
//! e o mesmo valor `{at, partial, releases[]}`, então Node e Rust enxergam o
//! MESMO índice — inclusive em restart (o índice é sempre nativo desde o R4).
//!
//! Regras do `record` portadas: merge por hash (mais recente vence), roteamento
//! da release pela temporada/episódio que o título (ou o `dn=` do magnet)
//! declara, `isBr`/`dubbed`/`lied` OR-aderentes, `seeders` pelo máximo, fonte de
//! mídia decidida pelo núcleo (`release_index_media`), corte protegido BR e o
//! flag `partial` (`keepPartial` nunca rebaixa).
//!
//! Leitura: `lookup` agrega episódio → temporada → raiz (dedupe por hash com o
//! `seenAt` mais recente); `is_partial` espelha as mesmas três chaves e qualquer
//! uma marcada bloqueia o fast-path do índice.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use adom_core::{prefix, quota_for, BankRow, WorkTarget};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// `CACHE_PERSIST=false` cai em memória (mesma regra do `raw.rs`).
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

/// Alias do `orchestrator::BankLookup` do adom-search: mesmo tipo, sem a dependência.
pub type BankLookup<'a> = &'a dyn Fn(&[String]) -> Vec<BankRow>;

// Provas laterais (miss, lied, evidência por arquivo, parcial, limpeza e
// leituras por varredura): submódulo para enxergar `conn` e os helpers daqui.
#[path = "release_index_prova.rs"]
mod prova;
pub use prova::FileEvidence;

// Consulta (lookup/is_partial) e poda do namespace.
#[path = "release_index_lookup.rs"]
mod lookup;

// Escrita (`releaseIndex.record`): merge por hash e corte protegido.
#[path = "release_index_record.rs"]
mod record;

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

/// Prefixo versionado vivo (`idx:v14:`).
pub fn idx_prefix() -> &'static str {
    prefix("idx")
}

/// Namespace de cota do índice.
pub const IDX_NAMESPACE: &str = "idx";

/// Uma release do índice, campo a campo como o Node grava.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct IndexedRelease {
    pub hash: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub indexer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracker: Option<String>,
    #[serde(default, rename = "isBr")]
    pub is_br: bool,
    #[serde(default)]
    pub dubbed: bool,
    #[serde(default)]
    pub quality: String,
    #[serde(default)]
    pub seeders: i64,
    #[serde(default, rename = "seenAt")]
    pub seen_at: i64,
    #[serde(default)]
    pub lied: bool,
    /// `'autofetch'` é registro do Chupim; ausente é observação pública.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(
        default,
        rename = "mediaSource",
        skip_serializing_if = "Option::is_none"
    )]
    pub media_source: Option<String>,
}

/// Valor de uma chave `idx`: `{at, partial, releases}`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct IndexEntry {
    #[serde(default)]
    pub at: i64,
    #[serde(default)]
    pub partial: bool,
    #[serde(default)]
    pub releases: Vec<IndexedRelease>,
}

/// Opções do `record` (o `opts` do TS).
#[derive(Clone, Copy, Debug, Default)]
pub struct RecordOptions<'a> {
    /// Marca de registro parcial (colheita interrompida).
    pub partial: bool,
    /// Nunca rebaixa uma chave que já era parcial para completa.
    pub keep_partial: bool,
    /// `'autofetch'` quando o lote veio do Chupim.
    pub source: Option<&'a str>,
}

/// Banco do índice (compartilhado com o `cache.db` do Node).
pub struct ReleaseIndexStore {
    conn: Mutex<Connection>,
    /// `RELEASE_INDEX_TTL` (default 30 d) usado pela escrita via trait.
    pub(crate) ttl_seconds: u64,
    /// `RELEASE_INDEX_MAX_RELEASES` (default 60).
    pub(crate) max_releases: usize,
}

impl ReleaseIndexStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|err| format!("pasta do índice: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir índice: {err}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema do índice: {err}"))?;
        drop_stale_idx(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            ttl_seconds: 30 * 24 * 3600,
            max_releases: 60,
        })
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        drop_stale_idx(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            ttl_seconds: 30 * 24 * 3600,
            max_releases: 60,
        })
    }

    /// Tetos do operador (`RELEASE_INDEX_TTL`/`_MAX_RELEASES`) usados pela
    /// escrita via `ReleaseIndexSource`.
    /// Tetos efetivos (leitura pelo wrapper de fonte do adom-store).
    pub fn ttl(&self) -> u64 {
        self.ttl_seconds
    }

    pub fn max_releases(&self) -> usize {
        self.max_releases
    }

    pub fn with_limits(mut self, ttl_seconds: u64, max_releases: usize) -> Self {
        self.ttl_seconds = ttl_seconds;
        self.max_releases = max_releases.max(1);
        self
    }

    /// `CACHE_PERSIST=false` cai em memória; o caminho é `CACHE_DB_PATH`
    /// (default `data/cache.db`), o mesmo do Node.
    pub fn from_env() -> Result<Self, String> {
        if !cache_persist() {
            eprintln!("[gateway] CACHE_PERSIST=false; idx:v14 só em memória");
            return Self::open_memory();
        }
        Self::open(&cache_db_path())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// `idx:v14:tt123` / `…:S2` / `…:S2E5`.
    fn obra_key(imdb_id: &str, location: WorkTarget) -> String {
        let mut key = format!("{}{}", idx_prefix(), imdb_id);
        if let Some(season) = location.season {
            key.push_str(&format!(":S{season}"));
            if let Some(episode) = location.episode {
                key.push_str(&format!("E{episode}"));
            }
        }
        key
    }

    fn read_entry(&self, key: &str, now_ms: i64) -> Option<IndexEntry> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT value, expires_at FROM cache WHERE key = ?1")
            .ok()?;
        let row: Option<(String, i64)> = stmt
            .query_row(params![key], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .ok();
        let (raw, expires_at) = row?;
        if expires_at <= now_ms {
            return None;
        }
        serde_json::from_str(&raw).ok()
    }

    fn write_entry(
        &self,
        key: &str,
        entry: &IndexEntry,
        ttl_seconds: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        if ttl_seconds == 0 {
            return Ok(());
        }
        let expires_at = now_ms.saturating_add(ttl_seconds.saturating_mul(1_000) as i64);
        let encoded = serde_json::to_string(entry).map_err(|err| err.to_string())?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, encoded, expires_at],
        )
        .map_err(|err| err.to_string())?;
        enforce_quota(&conn, IDX_NAMESPACE, now_ms)?;
        Ok(())
    }
}

/// Apaga `idx:` que não é a versão viva. Expirado some na leitura e no
/// `enforce_quota`; o relógio de parede no `open` quebraria testes com `NOW` fixo.
fn drop_stale_idx(conn: &Connection) -> Result<(), String> {
    let live = format!("{}%", idx_prefix());
    conn.execute(
        "DELETE FROM cache WHERE substr(key, 1, 4) = 'idx:' AND key NOT LIKE ?1",
        params![live],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Fora do TTL some; acima da cota o que expira primeiro cede lugar. Escopo do
/// namespace `idx` — nenhuma chave de outro namespace é tocada.
fn enforce_quota(conn: &Connection, namespace: &str, now_ms: i64) -> Result<(), String> {
    let prefix = format!("{namespace}:");
    let quota = quota_for(namespace) as i64;
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
    let extra = count - quota;
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

/// Caminho default do `cache.db` (diagnóstico/teste).
pub fn default_cache_db_path() -> PathBuf {
    cache_db_path()
}

#[cfg(test)]
#[path = "release_index_tests.rs"]
mod tests;
