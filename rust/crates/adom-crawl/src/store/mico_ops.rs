//! Operações da lane do Mico no `crawl.db`: leitura do que já está na fila
//! (corte incremental da descoberta) e enfileiramento com a MESMA regra do
//! `decideUpsert` do TS. Separado de `ops.rs` pela catraca de 400 linhas.

use std::collections::HashSet;

use rusqlite::params;

use super::ops::{CrawlStore, StoreError, UrlRow};

/// Resultado do enfileiramento (espelha `UpsertReport` do TS).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EnqueueReport {
    pub added: u32,
    pub refreshed: u32,
    pub unchanged: u32,
}

impl CrawlStore {
    /// Chaves de página (`url_key`) já conhecidas do site. Uma consulta só:
    /// o corte incremental da descoberta pergunta por ~milhares de IMDb ids e
    /// um `SELECT` por obra seria ruído no passo.
    pub fn known_url_keys(&self, site: &str) -> Result<HashSet<String>, StoreError> {
        let mut stmt = self
            .conn()
            .prepare("SELECT url_key FROM crawl_url WHERE site = ?1")?;
        let rows = stmt.query_map(params![site], |row| row.get::<_, String>(0))?;
        let mut out = HashSet::new();
        for row in rows {
            out.insert(row?);
        }
        Ok(out)
    }

    /// Enfileira a descoberta com a regra do `decideUpsert` (TS):
    /// - nova → `pending` do zero;
    /// - mesmo `lastmod` → só o `url` (host atual) acompanha, estado intacto;
    /// - `lastmod` novo → reprocessa do zero (preserva só a identidade), porque
    ///   o balde de releitura venceu e a obra precisa ser relida.
    ///
    /// NUNCA usa `INSERT OR REPLACE`: a descoberta roda a cada rodada e um
    /// REPLACE cego resetaria `status`/`progress` de série no meio do passe.
    pub fn enqueue_discovered(
        &self,
        site: &str,
        rows: &[UrlRow],
        now: i64,
    ) -> Result<EnqueueReport, StoreError> {
        if rows.is_empty() {
            return Ok(EnqueueReport::default());
        }
        let tx = self.conn().unchecked_transaction()?;
        let mut report = EnqueueReport::default();
        {
            let mut sel =
                tx.prepare("SELECT lastmod FROM crawl_url WHERE site = ?1 AND url_key = ?2")?;
            let mut ins = tx.prepare(
                "INSERT INTO crawl_url \
                 (site, url, url_key, lastmod, kind, status, imdb, tries, \
                  next_at, checked_at, releases, error, progress, added_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, 0, 0, 0, 0, '', '', ?7)",
            )?;
            let mut host =
                tx.prepare("UPDATE crawl_url SET url = ?3 WHERE site = ?1 AND url_key = ?2")?;
            let mut reset = tx.prepare(
                "UPDATE crawl_url SET url = ?3, lastmod = ?4, kind = ?5, \
                 status = 'pending', imdb = ?6, tries = 0, next_at = 0, \
                 checked_at = 0, releases = 0, error = '', progress = '', added_at = ?7 \
                 WHERE site = ?1 AND url_key = ?2",
            )?;
            for row in rows {
                let existing: Option<String> = {
                    let mut found = sel.query_map(params![site, row.url_key], |r| r.get(0))?;
                    match found.next() {
                        Some(Ok(value)) => Some(value),
                        Some(Err(e)) => return Err(e.into()),
                        None => None,
                    }
                };
                match existing {
                    None => {
                        ins.execute(params![
                            site,
                            row.url,
                            row.url_key,
                            row.lastmod,
                            row.kind,
                            row.imdb,
                            now,
                        ])?;
                        report.added += 1;
                    }
                    Some(lastmod) if lastmod == row.lastmod => {
                        host.execute(params![site, row.url_key, row.url])?;
                        report.unchanged += 1;
                    }
                    Some(_) => {
                        reset.execute(params![
                            site,
                            row.url_key,
                            row.url,
                            row.lastmod,
                            row.kind,
                            row.imdb,
                            now,
                        ])?;
                        report.refreshed += 1;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(report)
    }
}
