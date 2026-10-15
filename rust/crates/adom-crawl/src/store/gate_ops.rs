//! OperaÃ§Ãµes de portÃ£o do `crawl.db` (status `gate-pending` + tabela
//! `crawl_gate`). Separado do `ops.rs` pela catraca de 400 linhas; o
//! `impl CrawlStore` continua o mesmo tipo â€” sÃ³ a fonte Ã© outra.

use rusqlite::params;

use super::ops::{now_ms, row_from_sqlite, CrawlStore};
use super::types::{GatePendingRecord, GateRow, StoreError};

impl CrawlStore {
    /// Marca o post como PENDENTE DE PORTÃƒO (`gate-pending`) e grava o portÃ£o
    /// na `crawl_gate`.
    ///
    /// Diferente do `mark_result`: NÃƒO incrementa `tries` nem backoff â€” pendÃªncia
    /// de portÃ£o nÃ£o Ã© tentativa falha, Ã© custo deferido (FlareSolverr ~30s por
    /// post pago pelo executor de fundo). Envenenar a linha aqui seria punir o
    /// post pelo custo do site, nÃ£o por erro dele.
    pub fn mark_gate_pending(
        &self,
        site: &str,
        url_key: &str,
        rec: &GatePendingRecord,
    ) -> Result<(), StoreError> {
        let now = now_ms();
        self.conn().execute(
            "UPDATE crawl_url SET status='gate-pending', imdb=COALESCE(?3,imdb), \
             releases=0, error='', next_at=0, checked_at=?2 \
             WHERE site=?1 AND url_key=?4",
            params![site, now, rec.imdb, url_key],
        )?;
        self.conn().execute(
            "INSERT OR REPLACE INTO crawl_gate \
             (site, url_key, gate, title, year, imdb, kind, added_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                site,
                url_key,
                rec.gate,
                rec.title,
                rec.year,
                rec.imdb,
                rec.kind,
                now,
            ],
        )?;
        Ok(())
    }

    /// Toma posts pendentes de portÃ£o (o mais antigo primeiro, pelo
    /// `checked_at` da marcaÃ§Ã£o) para o executor de fundo. NÃƒO marca inflight:
    /// o executor Ã© single-loop e a linha continua `gate-pending` durante o
    /// pagamento â€” se o processo morrer no meio, a pendÃªncia sobrevive.
    pub fn take_gate_batch(&self, limit: usize) -> Result<Vec<GateRow>, StoreError> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut stmt = self.conn().prepare(
            "SELECT u.site, u.url, u.url_key, u.lastmod, u.kind, u.status, u.imdb, u.tries, \
                    u.next_at, u.checked_at, u.releases, u.error, u.progress, u.added_at, \
                    g.gate, g.title, g.year, g.imdb, g.kind \
             FROM crawl_url u \
             JOIN crawl_gate g ON g.site = u.site AND g.url_key = u.url_key \
             WHERE u.status = 'gate-pending' \
             ORDER BY u.checked_at, u.url_key \
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |row| {
            Ok(GateRow {
                row: row_from_sqlite(row)?,
                gate: row.get(14)?,
                title: row.get(15)?,
                year: row.get(16)?,
                imdb: row.get(17)?,
                kind: row.get(18)?,
            })
        })?;
        let collected: Result<Vec<_>, _> = rows.collect();
        Ok(collected?)
    }

    /// Apaga o registro do portÃ£o de um post (pago com sucesso e gravado no
    /// acervo). A linha do post jÃ¡ saiu de `gate-pending` via `mark_result`.
    pub fn clear_gate(&self, site: &str, url_key: &str) -> Result<(), StoreError> {
        self.conn().execute(
            "DELETE FROM crawl_gate WHERE site = ?1 AND url_key = ?2",
            params![site, url_key],
        )?;
        Ok(())
    }
}
