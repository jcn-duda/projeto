//! Operações do `crawl.db`: upsert, take_next, mark_result, contadores, etc.
//! Transações para passos múltiplos; `rusqlite::params!` (nunca interpolação).

use super::schema;
use rusqlite::{params, Connection};

pub use super::types::{MarkResult, StatusCounters, StoreError, UrlRow};

/// Acesso ao `crawl.db` (wraps `rusqlite::Connection`).
pub struct CrawlStore {
    conn: Connection,
}

impl CrawlStore {
    /// Abre (ou cria) o crawl.db no caminho dado.
    pub fn open(path: &str) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        // WAL + busy_timeout para concorrência segura (mesmo pragmas do TS).
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;")?;
        Ok(Self { conn })
    }

    /// Roda migrações (cria tabelas se não existem).
    pub fn migrate(&self) -> Result<(), StoreError> {
        schema::migrate(&self.conn).map_err(|e| StoreError::Migration(e.to_string()))
    }

    /// Insere/atualiza URLs descobertas (transação).
    ///
    /// Usa `INSERT OR REPLACE` na PK `(site, url_key)`. Se a linha já existe,
    /// os campos são sobrescritos com os valores novos — a URL mais recente
    /// vence.
    pub fn upsert_urls(&self, site: &str, urls: &[UrlRow]) -> Result<(), StoreError> {
        if urls.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO crawl_url \
                 (site, url, url_key, lastmod, kind, status, imdb, tries, \
                  next_at, checked_at, releases, error, progress, added_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            )?;
            for row in urls {
                stmt.execute(params![
                    site,
                    row.url,
                    row.url_key,
                    row.lastmod,
                    row.kind,
                    row.status,
                    row.imdb,
                    row.tries,
                    row.next_at,
                    row.checked_at,
                    row.releases,
                    row.error,
                    row.progress,
                    row.added_at,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Reivindica próxima URL due → retorna e marca inflight.
    ///
    /// Transação: SELECT da URL mais antiga due + UPDATE para 'inflight'.
    /// Retorna `None` se não há trabalho pendente.
    pub fn take_next(&self, site: &str) -> Result<Option<UrlRow>, StoreError> {
        // Roteamento single-owner: site own_pace (Mico) é do MOTOR TS. O sidecar
        // nunca o reivindica — o PageEngine o recusaria e a recusa queimaria
        // tentativa (2026-10: ~300 páginas do Mico viraram erro assim). A fila
        // fica intacta para o TS processar.
        if crate::site_profiles::is_own_pace(site) {
            return Ok(None);
        }
        let now = now_ms();
        let tx = self.conn.unchecked_transaction()?;

        // Busca a URL pendente mais antiga (menor next_at, depois menor url_key).
        let row = {
            let mut sel = tx.prepare(
                "SELECT site, url, url_key, lastmod, kind, status, imdb, tries, \
                        next_at, checked_at, releases, error, progress, added_at \
                 FROM crawl_url \
                 WHERE site = ?1 AND status = 'pending' AND next_at <= ?2 \
                 ORDER BY next_at, url_key \
                 LIMIT 1",
            )?;
            let mut rows = sel.query_map(params![site, now], row_from_sqlite)?;
            match rows.next() {
                Some(Ok(r)) => r,
                Some(Err(e)) => return Err(e.into()),
                None => return Ok(None),
            }
        };

        // Marca como inflight atomicamente.
        tx.execute(
            "UPDATE crawl_url SET status = 'inflight' WHERE site = ?1 AND url_key = ?2",
            params![site, row.url_key],
        )?;
        tx.commit()?;

        let mut claimed = row;
        claimed.status = "inflight".to_string();
        Ok(Some(claimed))
    }

    /// Reivindica lote de URLs due (até `limit` sites diferentes).
    ///
    /// Para cada site com URLs due, reclama uma URL. Transação única.
    pub fn take_next_batch(&self, limit: usize) -> Result<Vec<UrlRow>, StoreError> {
        let now = now_ms();
        let tx = self.conn.unchecked_transaction()?;

        // Sites com trabalho due, o atendido há MAIS tempo primeiro (última
        // página marcada do site). Pela fila sozinha (`MIN(next_at)`) todo site
        // empata em 0 e o desempate fixo deixava os mesmos quatro sempre na
        // frente: o TDF, com ~26 mil páginas na fila, nunca ganhava vaga.
        // SEM `LIMIT` aqui: own_pace é excluído logo abaixo e o teto real
        // (`limit`) é aplicado em Rust — se o Mico (fila antiga) estivesse no
        // recorte do SQL, ele consumiria uma vaga sem trabalhar.
        let sites: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT d.site FROM crawl_url d \
                 WHERE d.status = 'pending' AND d.next_at <= ?1 \
                 GROUP BY d.site \
                 ORDER BY (SELECT COALESCE(MAX(c.checked_at), 0) FROM crawl_url c \
                           WHERE c.site = d.site), \
                          MIN(d.next_at), d.site",
            )?;
            let rows = stmt.query_map(params![now], |row| row.get(0))?;
            let collected: Result<Vec<_>, _> = rows.collect();
            collected?
        };
        // Roteamento single-owner: sites own_pace são processados pelo motor TS;
        // o sidecar fica só com os demais.
        let sites: Vec<String> = sites
            .into_iter()
            .filter(|site| !crate::site_profiles::is_own_pace(site))
            .take(limit)
            .collect();

        let mut result = Vec::with_capacity(sites.len());
        {
            let mut sel = tx.prepare(
                "SELECT site, url, url_key, lastmod, kind, status, imdb, tries, \
                        next_at, checked_at, releases, error, progress, added_at \
                 FROM crawl_url \
                 WHERE site = ?1 AND status = 'pending' AND next_at <= ?2 \
                 ORDER BY next_at, url_key \
                 LIMIT 1",
            )?;
            let mut upd = tx.prepare(
                "UPDATE crawl_url SET status = 'inflight' WHERE site = ?1 AND url_key = ?2",
            )?;

            for site in &sites {
                // Scope de `rows`: precisa ser dropado antes da próxima iteração
                // para liberar o borrow mutável de `sel`.
                let maybe_row = {
                    let mut rows = sel.query_map(params![site, now], row_from_sqlite)?;
                    match rows.next() {
                        Some(Ok(r)) => Some(r),
                        Some(Err(e)) => return Err(e.into()),
                        None => None,
                    }
                };
                if let Some(mut row) = maybe_row {
                    upd.execute(params![site, row.url_key])?;
                    row.status = "inflight".to_string();
                    result.push(row);
                }
            }
        }
        tx.commit()?;
        Ok(result)
    }

    /// Existe trabalho vencido para o site?
    pub fn has_due(&self, site: &str) -> Result<bool, StoreError> {
        let now = now_ms();
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM crawl_url \
             WHERE site = ?1 AND status = 'pending' AND next_at <= ?2",
            params![site, now],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Grava resultado (terminal ou erro+backoff).
    ///
    /// Atualiza status, releases, error, progress, next_at, imdb, tries,
    /// checked_at. Se `result.next_at > 0`, o status volta para 'pending'
    /// (retry); caso contrário, fica no status terminal informado.
    pub fn mark_result(
        &self,
        site: &str,
        url_key: &str,
        result: &MarkResult,
    ) -> Result<(), StoreError> {
        let now = now_ms();
        let final_status = if result.next_at > 0 {
            "pending".into()
        } else {
            result.status.clone()
        };
        self.conn.execute(
            "UPDATE crawl_url SET status=?1, imdb=COALESCE(?2,imdb), \
             releases=?3, error=?4, progress=?5, next_at=?6, \
             tries=tries+1, checked_at=?7 WHERE site=?8 AND url_key=?9",
            params![
                final_status,
                result.imdb,
                result.releases,
                result.error,
                result.progress,
                result.next_at,
                now,
                site,
                url_key,
            ],
        )?;
        Ok(())
    }

    /// Crash recovery: URLs inflight voltam para pending.
    /// Retorna a quantidade de URLs reenfileiradas.
    pub fn requeue_inflight(&self, site: &str) -> Result<u32, StoreError> {
        let affected = self.conn.execute(
            "UPDATE crawl_url SET status = 'pending', next_at = 0 \
             WHERE site = ?1 AND status = 'inflight'",
            params![site],
        )?;
        Ok(affected as u32)
    }

    /// Reprocessar erros: URLs com status 'error' ou 'no-work' voltam para
    /// pending com next_at = 0. Retorna a quantidade reenfileirada.
    pub fn requeue_errors(&self, site: &str) -> Result<u32, StoreError> {
        let affected = self.conn.execute(
            "UPDATE crawl_url SET status = 'pending', next_at = 0, error = '' \
             WHERE site = ?1 AND status IN ('error', 'no-work')",
            params![site],
        )?;
        Ok(affected as u32)
    }

    /// Contadores por status (para o painel).
    pub fn counters(&self, site: &str) -> Result<StatusCounters, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT status, COUNT(*) FROM crawl_url WHERE site = ?1 GROUP BY status")?;
        let rows = stmt.query_map(params![site], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
        })?;

        let mut c = StatusCounters::default();
        for row in rows {
            let (status, count) = row?;
            match status.as_str() {
                "pending" => c.pending = count,
                "done" => c.done = count,
                "no-torrent" => c.no_torrent = count,
                "no-work" => c.no_work = count,
                "error" => c.error = count,
                "inflight" => c.inflight = count,
                "simulated" => c.simulated = count,
                _ => {} // status desconhecido, ignora
            }
        }
        Ok(c)
    }

    /// Total de releases do site (soma da coluna `releases`).
    pub fn sum_releases(&self, site: &str) -> Result<u32, StoreError> {
        let total: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(releases), 0) FROM crawl_url WHERE site = ?1",
            params![site],
            |row| row.get(0),
        )?;
        Ok(total as u32)
    }

    /// Zera site (destrutivo): apaga todas as URLs, estado e rodadas do site.
    pub fn clear_site(&self, site: &str) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM crawl_url WHERE site = ?1", params![site])?;
        tx.execute("DELETE FROM crawl_state WHERE site = ?1", params![site])?;
        tx.execute("DELETE FROM crawl_run WHERE site = ?1", params![site])?;
        tx.commit()?;
        Ok(())
    }

    /// Lê estado durável por site.
    pub fn get_state(&self, site: &str, key: &str) -> Result<Option<String>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM crawl_state WHERE site = ?1 AND key = ?2")?;
        let mut rows = stmt.query_map(params![site, key], |row| row.get(0))?;
        match rows.next() {
            Some(Ok(val)) => Ok(Some(val)),
            Some(Err(e)) => Err(e.into()),
            None => Ok(None),
        }
    }

    /// Grava estado durável por site (upsert).
    pub fn set_state(&self, site: &str, key: &str, value: &str) -> Result<(), StoreError> {
        let now = now_ms();
        self.conn.execute(
            "INSERT OR REPLACE INTO crawl_state (site, key, value, updated_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![site, key, value, now],
        )?;
        Ok(())
    }

    /// Inicia uma rodada de crawl. Retorna o `run_id`.
    pub fn start_run(&self, site: &str) -> Result<i64, StoreError> {
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO crawl_run (site, started_at) VALUES (?1, ?2)",
            params![site, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Finaliza uma rodada, gravando contadores JSON e timestamp.
    pub fn finish_run(&self, run_id: i64, counters: &str) -> Result<(), StoreError> {
        let now = now_ms();
        self.conn.execute(
            "UPDATE crawl_run SET finished_at = ?1, counters = ?2 WHERE id = ?3",
            params![now, counters, run_id],
        )?;
        Ok(())
    }

    /// Acesso direto à conexão (para testes ou operações avançadas).
    pub fn conn(&self) -> &Connection {
        &self.conn
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Epoch ms atual.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Extrai uma `UrlRow` de uma linha SQLite (mesma ordem do SELECT).
fn row_from_sqlite(row: &rusqlite::Row<'_>) -> rusqlite::Result<UrlRow> {
    Ok(UrlRow {
        site: row.get(0)?,
        url: row.get(1)?,
        url_key: row.get(2)?,
        lastmod: row.get(3)?,
        kind: row.get(4)?,
        status: row.get(5)?,
        imdb: row.get(6)?,
        tries: row.get(7)?,
        next_at: row.get(8)?,
        checked_at: row.get(9)?,
        releases: row.get(10)?,
        error: row.get(11)?,
        progress: row.get(12)?,
        added_at: row.get(13)?,
    })
}
