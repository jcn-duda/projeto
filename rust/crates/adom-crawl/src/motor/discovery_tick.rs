//! Descoberta de sitemap dentro do tick do [`CrawlMotor`] (fase 6).
//!
//! Sem esta costura o motor drenava a fila e parava em `sem-fila` para sempre:
//! a fila `crawl_url` é ALIMENTADA pela descoberta, e a única descoberta que
//! existia era a do Mico (`mico_lane`). É a regressão que esta fatia fecha.
//!
//! Contrato:
//!
//! - **um site por tick**, no máximo — a rodada de um site são dezenas de
//!   requisições e não pode segurar o lote paralelo;
//! - cada site tem o SEU relógio (memória do processo): restart descobre uma
//!   vez, que é o comportamento correto depois de um deploy;
//! - descoberta **completa** espera `discovery_interval_ms`; **parcial** ou
//!   erro volta no prazo curto de retry (as fontes perdidas precisam ser
//!   relidas, senão o cursor fica velho por uma hora);
//! - o custo REAL da rodada entra no MESMO teto por hora das páginas;
//! - cursor durável só avança com a completude DAQUELE kind (`next_cursor`).

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::r#loop::{with_store, CrawlMotor};
use super::types::now_ms;
use crate::discovery::{
    cursor_key, discoverable_sites, discovery_cuts, next_cursor, DiscoveryOptions, SiteDiscovery,
    CURSOR_MOVIE_KEY, LEGACY_CURSOR_KEY,
};
use crate::sitemap::CrawlPageKind;

/// O que UMA rodada de descoberta fez (log/painel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryTick {
    pub site: String,
    /// URLs que a rodada devolveu (antes da fila).
    pub urls: usize,
    /// Linhas novas na fila.
    pub added: u32,
    /// Linhas que voltaram a `pending` por `lastmod` novo.
    pub refreshed: u32,
    /// Requisições reais cobradas no teto por hora.
    pub cost: u32,
    /// Houve falha parcial (o cursor do kind afetado NÃO andou).
    pub partial: bool,
}

/// Relógio por site da próxima rodada. Memória de propósito: é agenda de
/// processo, não estado do acervo.
pub(super) type DiscoverClock = Arc<Mutex<HashMap<String, i64>>>;

impl CrawlMotor {
    /// Liga a descoberta de sitemap. Sem isto o motor não descobre nada e a
    /// fila só anda pelo que já estava lá (e pelo Mico).
    pub fn with_discovery(mut self, discovery: Arc<dyn SiteDiscovery>) -> Self {
        self.discovery = Some(discovery);
        self
    }

    /// A descoberta está plugada? (diagnóstico do painel)
    pub fn discovery_ready(&self) -> bool {
        self.discovery.as_ref().is_some_and(|d| d.is_ready())
    }

    /// Zera o relógio de todos os sites — gancho determinístico dos testes e
    /// do "reprocessar" do painel.
    pub async fn force_discovery(&self) {
        self.discover_next_at.lock().await.clear();
    }

    /// NO MÁXIMO uma rodada, e só do site vencido. `None` = nada a fazer
    /// (descoberta desligada, nenhum site vencido ou rodada sem resultado).
    pub(super) async fn discover_once(&self) -> Option<DiscoveryTick> {
        let discovery = self.discovery.clone()?;
        if !discovery.is_ready() {
            return None;
        }
        // Chamado fora do tick (painel/teste) o store ainda não foi aberto; sem
        // ele a rodada gastaria rede e não gravaria nada.
        if let Err(e) = self.ensure_store() {
            eprintln!("[motor] descoberta: store indisponível ({e})");
            return None;
        }
        let now = now_ms();
        let site = self.next_due_site(now).await?;

        let (movie, tv_show) = self.load_cursors(&site).await;
        let cuts = discovery_cuts(movie.as_deref(), tv_show.as_deref());
        let state_keys = discovery.state_keys(&site);
        let opts = DiscoveryOptions {
            since_movie: cuts.movie.clone(),
            since_tv_show: cuts.tv_show.clone(),
            emit_series: self.config.series_enabled,
            // Estado durável da trilha (cursor e marcador da listagem) lido
            // ANTES da rodada: a trilha é pura, quem lê o banco é o motor.
            site_state: self.load_site_state(&site, state_keys).await,
            listing_round_max_pages: self.config.listing_max_pages_per_round,
            now,
        };

        match discovery.discover(&site, &opts).await {
            Ok(report) => {
                self.charge_budget(report.request_cost).await;
                let tick = self.enqueue_report(&site, &report, now).await;
                self.schedule(&site, now, tick.partial).await;
                Some(tick)
            }
            Err(e) => {
                // Erro não derruba o motor: o site volta no retry curto.
                eprintln!("[motor] descoberta {site}: {e}");
                self.schedule(&site, now, true).await;
                None
            }
        }
    }

    /// Grava a fila e move os cursores completos. Devolve o resumo do tick.
    async fn enqueue_report(
        &self,
        site: &str,
        report: &crate::discovery::DiscoveryReport,
        now: i64,
    ) -> DiscoveryTick {
        let rows = report.to_rows(site, now);
        let mut added = 0u32;
        let mut refreshed = 0u32;
        let mut accepted = true;
        if !rows.is_empty() {
            let alvo = site.to_string();
            match with_store(self.store.clone(), move |db| {
                db.enqueue_discovered(&alvo, &rows, now)
            })
            .await
            {
                Ok(r) => {
                    added = r.added;
                    refreshed = r.refreshed;
                }
                Err(e) => {
                    eprintln!("[motor] descoberta {site}: enfileirar falhou: {e}");
                    accepted = false;
                }
            }
        }
        // Estado durável da rodada (cursor de listagem + marcador de séries).
        // SÓ depois de a fila ACEITAR as URLs: cursor que anda antes do
        // `enqueue` avança por cima de descoberta que nunca entrou na fila. A
        // ordem dentro de `state_writes` é da trilha (marcador antes do
        // cursor).
        if accepted {
            for (key, value) in &report.state_writes {
                self.write_state(site, key, value).await;
            }
        } else if !report.state_writes.is_empty() {
            eprintln!(
                "[motor] descoberta {site}: estado durável NÃO gravado ({} chave(s)) — \
                 a rodada será refeita",
                report.state_writes.len()
            );
        }
        for kind in [CrawlPageKind::Movie, CrawlPageKind::TvShow] {
            let Some(value) = next_cursor(report, kind) else {
                continue;
            };
            let s = site.to_string();
            let key = cursor_key(kind).to_string();
            if let Err(e) =
                with_store(self.store.clone(), move |db| db.set_state(&s, &key, &value)).await
            {
                eprintln!("[motor] descoberta {site}: cursor {kind:?} não gravou: {e}");
            }
        }
        let partial = !report.failures.is_empty();
        if partial {
            eprintln!(
                "[motor] descoberta {site}: PARCIAL ({} falha(s)): {}",
                report.failures.len(),
                report.failures.join(" | ")
            );
        }
        DiscoveryTick {
            site: site.to_string(),
            urls: report.urls.len(),
            added,
            refreshed,
            cost: report.request_cost,
            partial,
        }
    }

    /// Próximo site vencido, em rodízio (um site faminto não pode ser preterido
    /// por outro com fila grande).
    async fn next_due_site(&self, now: i64) -> Option<String> {
        let sites = discoverable_sites();
        if sites.is_empty() {
            return None;
        }
        let mut cursor = self.discover_cursor.lock().await;
        let clock = self.discover_next_at.lock().await;
        for offset in 0..sites.len() {
            let idx = (*cursor + offset) % sites.len();
            let site = sites[idx];
            if clock.get(site).copied().unwrap_or(0) <= now {
                *cursor = (idx + 1) % sites.len();
                return Some(site.to_string());
            }
        }
        None
    }

    /// Agenda a próxima rodada do site: intervalo cheio quando a rodada fechou
    /// completa, retry curto quando ficou parcial ou falhou.
    async fn schedule(&self, site: &str, now: i64, retry: bool) {
        let delay = if retry {
            self.config.retry_base_ms as i64
        } else {
            self.config.discovery_interval_ms as i64
        };
        self.discover_next_at
            .lock()
            .await
            .insert(site.to_string(), now.saturating_add(delay.max(1_000)));
    }

    /// Cursores por kind do site, com a migração do cursor LEGADO (Fase 6) para
    /// `cursor:movie` — uma vez, preservando a carga de filmes de instalação
    /// existente.
    async fn load_cursors(&self, site: &str) -> (Option<String>, Option<String>) {
        let movie = self.read_state(site, CURSOR_MOVIE_KEY).await;
        let movie = match movie {
            Some(m) => Some(m),
            None => match self.read_state(site, LEGACY_CURSOR_KEY).await {
                Some(legacy) => {
                    let s = site.to_string();
                    let value = legacy.clone();
                    let _ = with_store(self.store.clone(), move |db| {
                        db.set_state(&s, CURSOR_MOVIE_KEY, &value)
                    })
                    .await;
                    Some(legacy)
                }
                None => None,
            },
        };
        let tv_show = self.read_state(site, crate::discovery::CURSOR_TV_KEY).await;
        (movie, tv_show)
    }

    async fn read_state(&self, site: &str, key: &str) -> Option<String> {
        let s = site.to_string();
        let k = key.to_string();
        let value = with_store(self.store.clone(), move |db| db.get_state(&s, &k))
            .await
            .ok()
            .flatten()?;
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }

    /// Estado durável que a trilha pediu, já sem valores vazios (vazio é
    /// ausência para quem lê).
    async fn load_site_state(&self, site: &str, keys: Vec<String>) -> Vec<(String, String)> {
        let mut out = Vec::with_capacity(keys.len());
        for key in keys {
            if let Some(value) = self.read_state(site, &key).await {
                out.push((key, value));
            }
        }
        out
    }

    async fn write_state(&self, site: &str, key: &str, value: &str) {
        let s = site.to_string();
        let k = key.to_string();
        let v = value.to_string();
        if let Err(e) = with_store(self.store.clone(), move |db| db.set_state(&s, &k, &v)).await {
            eprintln!("[motor] descoberta {site}: estado {key} não gravou: {e}");
        }
    }
}

#[cfg(test)]
#[path = "discovery_tick_test_support.rs"]
mod test_support;

#[cfg(test)]
#[path = "discovery_tick_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "discovery_tick_state_tests.rs"]
mod state_tests;
