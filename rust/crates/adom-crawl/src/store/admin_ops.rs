//! Operações administrativas do `crawl.db` (ações do painel).
//!
//! Porta das duas recuperações one-shot que ainda moravam no Node:
//! `requeueSimulated` (`src/providers/crawl-recovery.ts` → `utils/crawl-store.ts`)
//! e `requeueErrors(site, 'no-work')` (`src/providers/crawl-actions.ts`).
//! A SQL é a MESMA do TS, inclusive nos detalhes que parecem excesso:
//!
//! - o passe seco zera `tries`, `error`, `progress` E `releases` — a contagem
//!   acumulada em dry-run é DESCOBERTA, não gravação; somá-la à releitura ao
//!   vivo duplicaria o total do painel;
//! - o match do dry-run é pelo PROGRESSO (`"dry":1`) em QUALQUER status, não só
//!   `simulated`: crash/falha preserva o progresso seco e o resume pularia
//!   cards nunca gravados.
//!
//! Fica fora do `ops.rs` pela catraca de 400 linhas.

use rusqlite::params;

use super::ops::CrawlStore;
use super::types::StoreError;

/// Teto de `url_key` devolvidos no relatório: a resposta é diagnóstico do
/// painel (contagem + amostra), não a lista inteira — um site varrido em
/// dry-run tem milhares de páginas e a resposta viraria megabytes.
pub const REQUEUE_IDS_LIMIT: usize = 100;

/// Chave durável do cursor de FILMES (`CURSOR_STATE_KEY.movie` do TS).
pub const CURSOR_MOVIE_KEY: &str = "cursor:movie";
/// Chave durável do cursor de SÉRIES (`CURSOR_STATE_KEY.tv_show` do TS).
pub const CURSOR_TV_SHOW_KEY: &str = "cursor:tv_show";
/// Cursor LEGADO da Fase 6 (único, antes do cursor por kind): migrado para
/// `cursor:movie` pela carga do motor e lido como fallback pelo painel.
pub const LEGACY_CURSOR_KEY: &str = "cursor";

/// O que um reenfileiramento administrativo fez.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequeueReport {
    /// Linhas efetivamente devolvidas à fila (`changes` do UPDATE).
    pub requeued: u32,
    /// Amostra das `url_key` tocadas, em ordem de fila (até
    /// [`REQUEUE_IDS_LIMIT`]).
    pub ids: Vec<String>,
}

impl CrawlStore {
    /// Dry-run desligou (true→false): `simulated` E qualquer linha com
    /// progresso seco (`"dry":1`, em qualquer status) volta a `pending` do
    /// zero. Idempotente: o reset limpa o `progress`, então repetir é no-op.
    ///
    /// NÃO toca em `done` sem progresso seco: versões antigas gravavam `done`
    /// em dry-run sem gravar acervo e não há evidência segura para separá-las
    /// de gravações reais — o operador decide com "Zerar site".
    pub fn requeue_simulated(&self, site: &str) -> Result<RequeueReport, StoreError> {
        self.requeue_matching(
            site,
            "status = 'simulated' OR progress LIKE '%\"dry\":1%'",
            "UPDATE crawl_url SET status = 'pending', tries = 0, next_at = 0, \
             error = '', releases = 0, progress = '' \
             WHERE site = ?1 AND (status = 'simulated' OR progress LIKE '%\"dry\":1%')",
        )
    }

    /// "Reprocessar sem obra": SÓ as `no-work` do site voltam à fila. O
    /// `no-work` é terminal (identificação negativa), então sem esta ação uma
    /// régua de identificação melhorada só valeria para página nova.
    ///
    /// `error` não entra aqui: é o "Reprocessar erros" (`requeue_errors`).
    pub fn requeue_no_work(&self, site: &str) -> Result<RequeueReport, StoreError> {
        self.requeue_matching(
            site,
            "status = 'no-work'",
            "UPDATE crawl_url SET status = 'pending', tries = 0, next_at = 0, \
             error = '', progress = '' WHERE site = ?1 AND status = 'no-work'",
        )
    }

    /// Amostra as chaves e aplica o UPDATE com o MESMO predicado — SELECT e
    /// UPDATE não podem divergir, senão o relatório mente.
    fn requeue_matching(
        &self,
        site: &str,
        predicate: &str,
        update_sql: &str,
    ) -> Result<RequeueReport, StoreError> {
        let ids = {
            // `predicate` é constante do crate (nunca entrada do operador).
            let select = format!(
                "SELECT url_key FROM crawl_url WHERE site = ?1 AND ({predicate}) \
                 ORDER BY next_at, url_key LIMIT ?2"
            );
            let mut stmt = self.conn().prepare(&select)?;
            let limit = REQUEUE_IDS_LIMIT as u32;
            let rows = stmt.query_map(params![site, limit], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<String>>>()?
        };
        let affected = self.conn().execute(update_sql, params![site])?;
        Ok(RequeueReport {
            requeued: affected as u32,
            ids,
        })
    }
}
