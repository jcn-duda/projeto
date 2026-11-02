//! Leituras do `crawl.db` que alimentam o painel (`GET /crawl/site-snapshot`).
//!
//! SÓ SELECT. A semântica espelha o TS `src/utils/crawl-store.ts` (`counters`,
//! `listByStatus`, `errorGroups`, `latestRun`) e `crawl-store-rules.ts`
//! (`parseStatus`). Diferenças deliberadas em relação a [`CrawlStore::counters`]
//! (que serve o `/status` do sidecar e fica intocado):
//! - conta `partial` (o `StatusCounters` não conta) e dobra status desconhecido
//!   em `pending`, como o `parseStatus` do TS;
//! - acha a coluna do cursor em `crawl_run`: o DDL do TS grava `cursor` e o do
//!   Rust grava `cursor_val`, e os dois convivem no mesmo arquivo.

use rusqlite::params;
use serde_json::{Map, Value};

use super::ops::{row_from_sqlite, CrawlStore};
use super::types::{StoreError, UrlRow};

/// Contagem por status com a MESMA chave do TS (`emptyCounters`). O total conta
/// todas as linhas do site, inclusive status que não cabe em nenhum campo.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatusTally {
    pub total: u32,
    pub pending: u32,
    pub inflight: u32,
    pub done: u32,
    pub no_torrent: u32,
    pub no_work: u32,
    pub error: u32,
    pub simulated: u32,
    pub partial: u32,
}

/// Rodada do motor, já no formato do TS (`CrawlRunRow`).
#[derive(Debug, Clone)]
pub struct RunSnapshot {
    pub id: i64,
    pub site: String,
    /// `incremental` só quando gravado assim; qualquer outra coisa vira `initial`.
    pub phase: &'static str,
    pub cursor: String,
    pub started_at: i64,
    /// `None` só para `NULL`. O DDL do Rust usa `DEFAULT 0`, e 0 sai como 0.
    pub finished_at: Option<i64>,
    /// Contadores JSON parseados; ilegível ou não-objeto vira `{}`.
    pub counters: Map<String, Value>,
}

impl CrawlStore {
    /// Contagens do site por status (ver [`StatusTally`]).
    pub fn status_tally(&self, site: &str) -> Result<StatusTally, StoreError> {
        let mut stmt = self
            .conn()
            .prepare("SELECT status, COUNT(*) FROM crawl_url WHERE site = ?1 GROUP BY status")?;
        let rows = stmt.query_map(params![site], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut tally = StatusTally::default();
        for row in rows {
            let (status, count) = row?;
            let n = count as u32;
            tally.total += n;
            match status.as_str() {
                "inflight" => tally.inflight += n,
                "done" => tally.done += n,
                "no-torrent" => tally.no_torrent += n,
                "no-work" => tally.no_work += n,
                "error" => tally.error += n,
                "simulated" => tally.simulated += n,
                "partial" => tally.partial += n,
                // `pending` e qualquer status fora da lista (ex.: `gate-pending`,
                // que o TS não conhece): o `parseStatus` do TS cai em pending.
                _ => tally.pending += n,
            }
        }
        Ok(tally)
    }

    /// Últimas linhas num status exato, por `checked_at` desc e depois `url_key`
    /// asc. `limit` 0 devolve vazio.
    pub fn list_by_status(
        &self,
        site: &str,
        status: &str,
        limit: u32,
    ) -> Result<Vec<UrlRow>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT site, url, url_key, lastmod, kind, status, imdb, tries, \
                    next_at, checked_at, releases, error, progress, added_at \
             FROM crawl_url WHERE site = ?1 AND status = ?2 \
             ORDER BY checked_at DESC, url_key ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![site, status, i64::from(limit)], row_from_sqlite)?;
        Ok(rows.collect::<rusqlite::Result<Vec<UrlRow>>>()?)
    }

    /// Erros `error` agrupados pelo texto cru, mais frequentes primeiro (empate:
    /// texto asc). Erro vazio vira `erro`, como no TS. O agrupamento estável
    /// (`series_truncated`...) é do painel, não do store.
    pub fn error_groups(&self, site: &str, limit: u32) -> Result<Vec<(String, u32)>, StoreError> {
        let mut stmt = self.conn().prepare(
            "SELECT error, COUNT(*) AS n FROM crawl_url \
             WHERE site = ?1 AND status = 'error' \
             GROUP BY error ORDER BY n DESC, error ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![site, i64::from(limit)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut groups = Vec::new();
        for row in rows {
            let (error, count) = row?;
            let reason = if error.is_empty() {
                "erro".to_string()
            } else {
                error
            };
            groups.push((reason, count as u32));
        }
        Ok(groups)
    }

    /// Rodada mais recente do site (`started_at` desc, depois `id` desc).
    pub fn latest_run(&self, site: &str) -> Result<Option<RunSnapshot>, StoreError> {
        // O nome da coluna vem de um conjunto FIXO (não de entrada), então a
        // interpolação no SQL é segura.
        let cursor_col = self.run_cursor_column()?;
        let cursor_expr = if cursor_col.is_empty() {
            "''"
        } else {
            cursor_col
        };
        let sql = format!(
            "SELECT id, site, phase, {cursor_expr}, started_at, finished_at, counters \
             FROM crawl_run WHERE site = ?1 ORDER BY started_at DESC, id DESC LIMIT 1"
        );
        let mut stmt = self.conn().prepare(&sql)?;
        let mut rows = stmt.query_map(params![site], |row| {
            Ok(RawRun {
                id: row.get(0)?,
                site: row.get(1)?,
                phase: row.get(2)?,
                cursor: row.get(3)?,
                started_at: row.get(4)?,
                finished_at: row.get(5)?,
                counters: row.get(6)?,
            })
        })?;
        let Some(raw) = rows.next() else {
            return Ok(None);
        };
        let raw = raw?;
        Ok(Some(RunSnapshot {
            id: raw.id,
            site: raw.site,
            phase: if raw.phase == "incremental" {
                "incremental"
            } else {
                "initial"
            },
            cursor: raw.cursor,
            started_at: raw.started_at,
            finished_at: raw.finished_at,
            counters: parse_counters(&raw.counters),
        }))
    }

    /// Coluna do cursor em `crawl_run`: `cursor` (DDL do TS), `cursor_val` (DDL
    /// do Rust) ou vazio quando nenhuma existe.
    fn run_cursor_column(&self) -> Result<&'static str, StoreError> {
        let mut stmt = self.conn().prepare("PRAGMA table_info(crawl_run)")?;
        let names: rusqlite::Result<Vec<String>> =
            stmt.query_map([], |row| row.get::<_, String>(1))?.collect();
        let names = names?;
        Ok(if names.iter().any(|n| n == "cursor") {
            "cursor"
        } else if names.iter().any(|n| n == "cursor_val") {
            "cursor_val"
        } else {
            ""
        })
    }
}

/// Linha crua de `crawl_run`, antes de normalizar `phase` e `counters`.
struct RawRun {
    id: i64,
    site: String,
    phase: String,
    cursor: String,
    started_at: i64,
    finished_at: Option<i64>,
    counters: String,
}

/// JSON dos contadores: só objeto vale; o resto (ilegível, array, escalar) é `{}`.
fn parse_counters(raw: &str) -> Map<String, Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}
