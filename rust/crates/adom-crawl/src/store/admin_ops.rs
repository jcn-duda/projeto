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
//! `clear_site` (o "Zerar site", com o veredito da sonda preservado) e os
//! reparos únicos de boot (Vaca no-torrent; tries de adiamento 429) completam
//! as ações do painel. Fica fora do `ops.rs` pela catraca de 400 linhas.

use rusqlite::params;

use super::ops::{CrawlStore, PROBE_VERDICT_KEY};
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

    /// Crash recovery: URLs inflight voltam para pending.
    /// Retorna a quantidade de URLs reenfileiradas.
    pub fn requeue_inflight(&self, site: &str) -> Result<u32, StoreError> {
        let affected = self.conn().execute(
            "UPDATE crawl_url SET status = 'pending', next_at = 0 \
             WHERE site = ?1 AND status = 'inflight'",
            params![site],
        )?;
        Ok(affected as u32)
    }

    /// Reprocessar erros: URLs com status 'error' ou 'no-work' voltam para
    /// pending com next_at = 0. Retorna a quantidade reenfileirada.
    pub fn requeue_errors(&self, site: &str) -> Result<u32, StoreError> {
        let affected = self.conn().execute(
            "UPDATE crawl_url SET status = 'pending', next_at = 0, error = '' \
             WHERE site = ?1 AND status IN ('error', 'no-work')",
            params![site],
        )?;
        Ok(affected as u32)
    }

    /// Reparo ÚNICO do Vaca: o motor Rust lia só o post, que não publica botão,
    /// e fechou o acervo como `no-torrent` (terminal, nunca relido). Devolve essas
    /// linhas à fila uma vez; o marcador em `crawl_state` impede que obra sem
    /// torrent de verdade volte a cada boot. `done` e `error` não mudam.
    pub fn repair_vaca_no_torrent_once(&self) -> Result<u32, StoreError> {
        const SITE: &str = "vacatorrent";
        const MARK: &str = "repair:no-torrent-botoes-v1";
        if self.get_state(SITE, MARK)?.is_some() {
            return Ok(0);
        }
        let report = self.requeue_matching(
            SITE,
            "status = 'no-torrent'",
            "UPDATE crawl_url SET status = 'pending', tries = 0, next_at = 0, \
             error = '', progress = '' WHERE site = ?1 AND status = 'no-torrent'",
        )?;
        self.set_state(SITE, MARK, &report.requeued.to_string())?;
        Ok(report.requeued)
    }

    /// Zera site (destrutivo): apaga todas as URLs, estado, rodadas e pendências
    /// de portão do site — EXCETO o veredito da sonda. O TS preservava (leitura
    /// antes do clear e regravação depois, `crawl-actions.ts` `resetSite`) e o
    /// gate sem veredito barra um site já autorizado: zerar a fila não pode
    /// desautorizar o que foi medido.
    pub fn clear_site(&self, site: &str) -> Result<(), StoreError> {
        let probe = self.get_state(site, PROBE_VERDICT_KEY)?;
        let tx = self.conn().unchecked_transaction()?;
        tx.execute("DELETE FROM crawl_url WHERE site = ?1", params![site])?;
        tx.execute("DELETE FROM crawl_state WHERE site = ?1", params![site])?;
        tx.execute("DELETE FROM crawl_run WHERE site = ?1", params![site])?;
        tx.execute("DELETE FROM crawl_gate WHERE site = ?1", params![site])?;
        tx.commit()?;
        // Mesma janela do TS (leitura → clear → regrava): a sonda não grava
        // veredito concorrente com o botão de zerar na prática.
        if let Some(verdict) = probe {
            self.set_state(site, PROBE_VERDICT_KEY, &verdict)?;
        }
        Ok(())
    }

    /// Reparo ÚNICO das tries de adiamento: o motor antigo debitava `tries` em
    /// 429 (Retry-After) e ~471 páginas do Vaca ficaram com tries=1 + error
    /// `http_429*` — a próxima re-429 viraria `error` terminal. Zera `tries`
    /// dessas linhas UMA vez; o marcador é global (`__global__`, o 429 é do
    /// Cloudflare na frente, não de um site) e a 2ª rodada é no-op. Só toca
    /// `tries`: status, erro e next_at ficam como o motor os gravou.
    pub fn repair_http429_once(&self) -> Result<u32, StoreError> {
        const MARK_SITE: &str = "__global__";
        const MARK: &str = "repair:http429-tries-v1";
        if self.get_state(MARK_SITE, MARK)?.is_some() {
            return Ok(0);
        }
        let affected = self.conn().execute(
            "UPDATE crawl_url SET tries = 0 \
             WHERE tries = 1 AND error LIKE 'http_429%'",
            [],
        )?;
        self.set_state(MARK_SITE, MARK, &affected.to_string())?;
        Ok(affected as u32)
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
