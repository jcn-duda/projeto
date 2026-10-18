//! Persistência L2 da fila `harvest:v1:q` (SQLite, WAL).
//!
//! Espelha o padrão de `adom-store` / `adom-debrid::store` (rusqlite, tabela
//! `cache` com `key`/`value`/`expires_at`) e o contrato TS de
//! `harvest-queue.ts`: `load` = `cache.get(QUEUE_KEY)`; `save` = `cache.set`
//! (ou `forget` se vazia). A mutação continua em [`HarvestQueue`] em memória;
//! este store só materializa o array.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};

use crate::queue::QUEUE_KEY;
use crate::reason::is_valid_imdb_id;
use crate::types::HarvestEntry;

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

/// Banco SQLite da chave única `harvest:v1:q`.
///
/// Fora do caminho `/stream` — o gateway não abre este store.
pub struct HarvestStore {
    conn: Mutex<Connection>,
}

impl HarvestStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("pasta do harvest store: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir harvest store: {err}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema harvest store: {err}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// `cache.get(harvest:v1:q)` — miss/expirado → `[]`; filtra IMDb inválido.
    pub fn load(&self, now_ms: i64) -> Result<Vec<HarvestEntry>, String> {
        let conn = self.lock();
        let Some((value, expires_at)) = read_row(&conn, QUEUE_KEY)? else {
            return Ok(Vec::new());
        };
        if expires_at <= now_ms {
            conn.execute("DELETE FROM cache WHERE key = ?1", params![QUEUE_KEY])
                .map_err(|err| err.to_string())?;
            return Ok(Vec::new());
        }
        let raw: Vec<HarvestEntry> =
            serde_json::from_str(&value).map_err(|err| format!("fila harvest inválida: {err}"))?;
        Ok(raw
            .into_iter()
            .filter(|e| is_valid_imdb_id(&e.imdb_id))
            .collect())
    }

    /// `persist()` do TS: vazio → `forget`; senão grava o array com TTL.
    pub fn save(
        &self,
        entries: &[HarvestEntry],
        ttl_seconds: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        if entries.is_empty() {
            return self.forget_queue();
        }
        let expires_at = now_ms.saturating_add((ttl_seconds as i64).saturating_mul(1000));
        let encoded = serde_json::to_string(entries).map_err(|err| err.to_string())?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![QUEUE_KEY, encoded, expires_at],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    pub fn forget_queue(&self) -> Result<(), String> {
        let conn = self.lock();
        conn.execute("DELETE FROM cache WHERE key = ?1", params![QUEUE_KEY])
            .map_err(|err| err.to_string())?;
        Ok(())
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
    fn put_raw_for_test(&self, value: &str, expires_at: i64) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::{HarvestQueue, HarvestQueueConfig};
    use crate::types::{HarvestMediaType, HarvestRequest};

    fn clock_fixed() -> i64 {
        1_700_000_000_000
    }

    fn sample_entry(imdb: &str) -> HarvestEntry {
        HarvestEntry {
            imdb_id: imdb.into(),
            media_type: HarvestMediaType::Movie,
            season: None,
            episode: None,
            reason: "miss".into(),
            enqueued_at: clock_fixed(),
            priority_at: None,
            resumed: false,
            br_probe: false,
            full_base: false,
        }
    }

    #[test]
    fn open_memory_save_load_roundtrip() {
        let store = HarvestStore::open_memory().unwrap();
        let entries = vec![sample_entry("tt0111161"), sample_entry("tt0068646")];
        store
            .save(&entries, DEFAULT_ENTRY_TTL_SECONDS, clock_fixed())
            .unwrap();
        assert!(store.has_queue(clock_fixed()).unwrap());
        let loaded = store.load(clock_fixed()).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].imdb_id, "tt0111161");
        assert_eq!(loaded[1].imdb_id, "tt0068646");
    }

    #[test]
    fn save_vazio_apaga_chave() {
        let store = HarvestStore::open_memory().unwrap();
        store
            .save(&[sample_entry("tt0111161")], 60, clock_fixed())
            .unwrap();
        store.save(&[], 60, clock_fixed()).unwrap();
        assert!(!store.has_queue(clock_fixed()).unwrap());
        assert!(store.load(clock_fixed()).unwrap().is_empty());
    }

    #[test]
    fn load_expirado_apaga_e_devolve_vazio() {
        let store = HarvestStore::open_memory().unwrap();
        store
            .save(&[sample_entry("tt0111161")], 60, clock_fixed())
            .unwrap();
        let past = clock_fixed() + 60_000 + 1;
        assert!(store.load(past).unwrap().is_empty());
        assert!(!store.has_queue(past).unwrap());
    }

    #[test]
    fn load_filtra_imdb_invalido() {
        let store = HarvestStore::open_memory().unwrap();
        // JSON cru com entrada podre (como L2 legado).
        store
            .put_raw_for_test(
                r#"[{"imdbId":"nope","type":"movie","reason":"miss","enqueuedAt":1},{"imdbId":"tt0111161","type":"movie","reason":"miss","enqueuedAt":1}]"#,
                clock_fixed() + 60_000,
            )
            .unwrap();
        let loaded = store.load(clock_fixed()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].imdb_id, "tt0111161");
    }

    #[test]
    fn fila_em_memoria_flush_periodico() {
        // enqueue/take_head mutam a memória; save/load espelham cache.set do TS.
        let store = HarvestStore::open_memory().unwrap();
        let mut queue = HarvestQueue::with_clock(
            HarvestQueueConfig {
                queue_max: 10,
                ..HarvestQueueConfig::default()
            },
            clock_fixed,
        );
        queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
        queue.enqueue(HarvestRequest::movie("tt0068646", "br-gap"));
        queue
            .save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, clock_fixed())
            .unwrap();

        let mut other = HarvestQueue::with_clock(
            HarvestQueueConfig {
                queue_max: 10,
                ..HarvestQueueConfig::default()
            },
            clock_fixed,
        );
        other.load_from(&store, clock_fixed(), None).unwrap();
        assert_eq!(other.depth(), 2);
        let head = other.take_head().expect("cabeça");
        assert_eq!(head.imdb_id, "tt0111161");
        assert_eq!(other.preview(1)[0].reason, "br-gap");
    }

    #[test]
    fn open_path_persiste_em_disco() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("harvest.db");
        {
            let store = HarvestStore::open(&path).unwrap();
            store
                .save(&[sample_entry("tt0111161")], 3600, clock_fixed())
                .unwrap();
        }
        let store = HarvestStore::open(&path).unwrap();
        let loaded = store.load(clock_fixed()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].imdb_id, "tt0111161");
    }
}
