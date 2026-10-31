//! Linhas e motor SQLite (`catalog-rows.ts`).
//!
//! `upsert_row` preserva o histórico: `first_seen` não regride, a auditoria de
//! ARQUIVOS é durável (título nunca vence arquivo) e o mesmo `service_id` que
//! volta à conta reabre o tombstone.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Estados em que a AllDebrid ainda trabalha: a limpeza não toca download em curso.
pub fn is_active(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "queued" | "downloading" | "processing" | "compressing" | "moving" | "uploading"
    )
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub adapter: String,
    pub account: String,
    pub service_id: String,
    pub hash: String,
    pub filename: String,
    pub size: i64,
    pub status: String,
    pub ready: i64,
    pub uploaded_at: i64,
    pub bucket: String,
    pub audio: String,
    pub foreign_proof: String,
    pub pt_proof: String,
    pub imdb_id: String,
    pub work_title: String,
    pub work_is_br: i64,
    pub work_dubbed: i64,
    pub work_lied: i64,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub cached: String,
    pub cached_at: i64,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    /// Quando a auditoria de ARQUIVOS mediu esta linha (prova durável).
    pub audited_at: i64,
    pub deleted_at: i64,
    pub delete_reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MarkInput {
    pub service_id: String,
    pub reason: String,
}

const SCHEMA: &str = "
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS magnet (
      adapter TEXT NOT NULL, account TEXT NOT NULL, service_id TEXT NOT NULL,
      hash TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT '', ready INTEGER NOT NULL DEFAULT 0,
      uploaded_at INTEGER NOT NULL DEFAULT 0,
      bucket TEXT NOT NULL DEFAULT '',
      audio TEXT NOT NULL DEFAULT '',
      foreign_proof TEXT NOT NULL DEFAULT '',
      pt_proof TEXT NOT NULL DEFAULT '',
      imdb_id TEXT NOT NULL DEFAULT '', work_title TEXT NOT NULL DEFAULT '',
      work_is_br INTEGER NOT NULL DEFAULT 0, work_dubbed INTEGER NOT NULL DEFAULT 0,
      work_lied INTEGER NOT NULL DEFAULT 0,
      season INTEGER, episode INTEGER,
      cached TEXT NOT NULL DEFAULT 'unknown',
      cached_at INTEGER NOT NULL DEFAULT 0,
      first_seen_at INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL DEFAULT 0,
      audited_at INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER NOT NULL DEFAULT 0, delete_reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (adapter, account, service_id)
    );
    CREATE INDEX IF NOT EXISTS magnet_hash ON magnet (hash);
    CREATE INDEX IF NOT EXISTS magnet_imdb ON magnet (imdb_id);
    CREATE INDEX IF NOT EXISTS magnet_bucket ON magnet (bucket);
    CREATE INDEX IF NOT EXISTS magnet_cached ON magnet (cached);
";

const COLUMNS: &str = "adapter, account, service_id, hash, filename, size, status, ready, \
    uploaded_at, bucket, audio, foreign_proof, pt_proof, imdb_id, work_title, work_is_br, \
    work_dubbed, work_lied, season, episode, cached, cached_at, first_seen_at, last_seen_at, \
    audited_at, deleted_at, delete_reason";

fn parse(row: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    Ok(Row {
        adapter: row.get(0)?,
        account: row.get(1)?,
        service_id: row.get(2)?,
        hash: row.get(3)?,
        filename: row.get(4)?,
        size: row.get(5)?,
        status: row.get(6)?,
        ready: row.get(7)?,
        uploaded_at: row.get(8)?,
        bucket: row.get(9)?,
        audio: row.get(10)?,
        foreign_proof: row.get(11)?,
        pt_proof: row.get(12)?,
        imdb_id: row.get(13)?,
        work_title: row.get(14)?,
        work_is_br: row.get(15)?,
        work_dubbed: row.get(16)?,
        work_lied: row.get(17)?,
        season: row.get(18)?,
        episode: row.get(19)?,
        cached: row.get(20)?,
        cached_at: row.get(21)?,
        first_seen_at: row.get(22)?,
        last_seen_at: row.get(23)?,
        audited_at: row.get(24)?,
        deleted_at: row.get(25)?,
        delete_reason: row.get(26)?,
    })
}

/// Motor do catálogo. Sem fallback em memória silencioso: quem abre decide o
/// que fazer com o `Err` (o painel responde indisponível, a busca não depende).
pub struct CatalogStore {
    conn: Mutex<Connection>,
}

impl CatalogStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        let conn = Connection::open(path).map_err(|err| err.to_string())?;
        Self::prepare(conn)
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        Self::prepare(conn)
    }

    fn prepare(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        // Banco anterior à auditoria durável: o erro de duplicata é o "já existe".
        let _ = conn.execute(
            "ALTER TABLE magnet ADD COLUMN audited_at INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "UPDATE magnet SET audited_at = last_seen_at WHERE audited_at = 0 AND pt_proof = 'arquivo'",
            [],
        );
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub fn get_row(
        &self,
        adapter: &str,
        account: &str,
        service_id: &str,
    ) -> Result<Option<Row>, String> {
        let sql = format!(
            "SELECT {COLUMNS} FROM magnet WHERE adapter = ?1 AND account = ?2 AND service_id = ?3"
        );
        self.lock()
            .query_row(&sql, params![adapter, account, service_id], parse)
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn list_rows(&self, adapter: &str, account: &str) -> Result<Vec<Row>, String> {
        let sql = format!("SELECT {COLUMNS} FROM magnet WHERE adapter = ?1 AND account = ?2");
        let conn = self.lock();
        let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map(params![adapter, account], parse)
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }

    /// Grava a linha inteira (INSERT ou UPDATE pela chave primária).
    pub fn put_row(&self, row: &Row) -> Result<(), String> {
        let sql = format!(
            "INSERT OR REPLACE INTO magnet ({COLUMNS}) VALUES \
             (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)"
        );
        self.lock()
            .execute(
                &sql,
                params![
                    row.adapter,
                    row.account,
                    row.service_id,
                    row.hash,
                    row.filename,
                    row.size,
                    row.status,
                    row.ready,
                    row.uploaded_at,
                    row.bucket,
                    row.audio,
                    row.foreign_proof,
                    row.pt_proof,
                    row.imdb_id,
                    row.work_title,
                    row.work_is_br,
                    row.work_dubbed,
                    row.work_lied,
                    row.season,
                    row.episode,
                    row.cached,
                    row.cached_at,
                    row.first_seen_at,
                    row.last_seen_at,
                    row.audited_at,
                    row.deleted_at,
                    row.delete_reason,
                ],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    /// Tombstone em lote, numa transação (`markDeleted`).
    pub fn mark_deleted(
        &self,
        adapter: &str,
        account: &str,
        items: &[MarkInput],
        now_ms: i64,
    ) -> Result<usize, String> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(|err| err.to_string())?;
        for item in items {
            tx.execute(
                "UPDATE magnet SET deleted_at = ?1, delete_reason = ?2 \
                 WHERE adapter = ?3 AND account = ?4 AND service_id = ?5",
                params![now_ms, item.reason, adapter, account, item.service_id],
            )
            .map_err(|err| err.to_string())?;
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(items.len())
    }

    /// Upsert que preserva o histórico (`upsertRow`).
    pub fn upsert_row(&self, row: &Row) -> Result<(), String> {
        let Some(prev) = self.get_row(&row.adapter, &row.account, &row.service_id)? else {
            return self.put_row(row);
        };
        self.put_row(&merge_upsert(&prev, row))
    }
}

/// A prova medida nos ARQUIVOS é durável; absolvição só por TÍTULO não congela.
fn merge_upsert(prev: &Row, row: &Row) -> Row {
    let keep_audited = row.audited_at == 0
        && (prev.pt_proof == "arquivo" || (!prev.foreign_proof.is_empty() && prev.audited_at > 0));
    let mut merged = row.clone();
    merged.first_seen_at = if prev.first_seen_at != 0 {
        prev.first_seen_at
    } else {
        row.first_seen_at
    };
    merged.audited_at = prev.audited_at.max(row.audited_at);
    if keep_audited {
        merged.foreign_proof = prev.foreign_proof.clone();
        merged.pt_proof = prev.pt_proof.clone();
        if row.audio.is_empty() {
            merged.audio = prev.audio.clone();
        }
    }
    // `cached_at` só renova quando o veredito muda.
    if !prev.cached.is_empty() && row.cached == prev.cached {
        merged.cached_at = prev.cached_at;
    }
    merged.deleted_at = 0;
    merged.delete_reason = String::new();
    merged
}

#[cfg(test)]
#[path = "rows_tests.rs"]
mod rows_tests;
