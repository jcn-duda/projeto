//! Descoberta nativa do Mico no motor Rust (Fase 6).
//!
//! Porta fiel de `src/providers/crawl-sites/mico-shared.ts`:
//! - paginação por `skip` com **passo FIXO** (`stride_at`: 25 até 1000, 50
//!   depois) — `meta.length` NÃO mede o índice bruto do catálogo;
//! - página vazia é INTERMITENTE na API: reconsulta até
//!   `empty_retries` vezes antes de contá-la como vazia;
//! - fim só depois de `end_after_empties` páginas vazias SEGUIDAS (já
//!   reconsultadas) e teto duro de `max_pages` requisições por tipo;
//! - varredura COMPLETA só a cada `full_sweep_hours` (marcador
//!   `full-sweep:<tipo>` no `crawl_state`); entre elas a rodada é INCREMENTAL
//!   e para depois de `known_pages_to_stop` páginas só com obras já na fila —
//!   sai `complete` sem mover o marcador;
//! - `lastmod` sintético por balde (`bucket_lastmod`), que é o que reenfileira
//!   a obra quando o balde vira.
//!
//! A rede vem da trait [`MicoApi`]; o store é lido/escrito pelo chamador
//! (`motor::mico_lane`), então tudo aqui é testável sem SQLite e sem HTTP.

use std::collections::HashSet;

use crate::mico::{bucket_lastmod, stride_at, synthetic_url, MicoKind};
use crate::mico_net::api::MicoApi;
use crate::mico_net::types::CatalogType;
use crate::store::url_key::crawl_url_key;
use crate::store::UrlRow;

const HOUR_MS: i64 = 3_600_000;

/// Configuração da lane do Mico (lida do `.env` em `adom_sidecar`).
#[derive(Debug, Clone)]
pub struct MicoCrawlConfig {
    /// Id do site na fila (`mico`).
    pub site: String,
    /// URL base da API (sem barra final).
    pub base_url: String,
    /// Teto de requisições de catálogo por tipo e por rodada.
    pub max_pages: u32,
    /// Reconsultas de uma página vazia antes de contá-la como vazia.
    pub empty_retries: u32,
    /// Quantas vazias seguidas (já reconsultadas) valem como fim do catálogo.
    pub end_after_empties: u32,
    /// Páginas seguidas só com obras já na fila que encerram a rodada incremental.
    pub known_pages_to_stop: u32,
    /// Intervalo mínimo entre varreduras COMPLETAS, em horas.
    pub full_sweep_hours: i64,
    /// Balde de releitura de FILME (dias).
    pub reread_days_movie: u32,
    /// Balde de releitura de SÉRIE (dias) — mais longo, cada obra custa mais.
    pub reread_days_series: u32,
    /// Descobre séries além de filmes.
    pub series_enabled: bool,
    /// Temporadas mais recentes lidas por série.
    pub series_max_seasons: u32,
    /// Episódios por passe de leitura de série (progresso retomável).
    pub series_max_buttons: u32,
    /// Intervalo entre rodadas de descoberta (incremental), em ms.
    pub discovery_interval_ms: i64,
}

impl Default for MicoCrawlConfig {
    fn default() -> Self {
        Self {
            site: "mico".to_string(),
            base_url: crate::mico::DEFAULT_MICO_URL.to_string(),
            max_pages: 700,
            empty_retries: 2,
            end_after_empties: 4,
            known_pages_to_stop: 2,
            full_sweep_hours: 24,
            reread_days_movie: 14,
            reread_days_series: 30,
            series_enabled: true,
            series_max_seasons: 2,
            series_max_buttons: 40,
            discovery_interval_ms: 3_600_000,
        }
    }
}

/// Tipo de catálogo do `MicoKind` para o cliente.
pub fn catalog_type(kind: MicoKind) -> CatalogType {
    match kind {
        MicoKind::Movie => CatalogType::Movie,
        MicoKind::Series => CatalogType::Series,
    }
}

/// Nome do tipo no vocabulário do catálogo (`movie`/`series`).
pub fn kind_slug(kind: MicoKind) -> &'static str {
    match kind {
        MicoKind::Movie => "movie",
        MicoKind::Series => "series",
    }
}

/// `kind` da FILA (`movie`/`tv_show`).
pub fn queue_kind(kind: MicoKind) -> &'static str {
    match kind {
        MicoKind::Movie => "movie",
        MicoKind::Series => "tv_show",
    }
}

/// Chave do marcador de varredura completa por tipo.
pub fn full_sweep_key(kind: MicoKind) -> String {
    format!("full-sweep:{}", kind_slug(kind))
}

/// A varredura de hoje é COMPLETA? `last` é o valor gravado no `crawl_state`
/// (epoch ms como texto); ausente/ilegível = nunca varreu = completa.
pub fn is_full_sweep(last: Option<&str>, now: i64, hours: i64) -> bool {
    let last = last.and_then(|v| v.trim().parse::<i64>().ok()).unwrap_or(0);
    now.saturating_sub(last) >= hours.max(1).saturating_mul(HOUR_MS)
}

/// Resultado do passe de paginação de UM tipo.
#[derive(Debug, Clone, Default)]
pub struct CatalogWalk {
    /// IMDb ids descobertos, na ordem do catálogo e sem repetição.
    pub ids: Vec<String>,
    /// Falhas de página (best-effort: uma página ruim não derruba a rodada).
    pub failures: Vec<String>,
    /// Requisições feitas (inclui reconsultas de vazio e tentativas falhas).
    pub pages: u32,
    /// A PRIMEIRA requisição da rodada falhou (falha total do tipo).
    pub first_page_failed: bool,
    /// O catálogo terminou (vazias seguidas suficientes).
    pub saw_end: bool,
    /// Parou por páginas seguidas só com obras já na fila.
    pub stopped_at_known: bool,
}

impl CatalogWalk {
    /// Descoberta COMPLETA: sem falhas, com obra e com fim provado (fim real
    /// ou corte por conhecidas). É a régua do `complete` do TS.
    pub fn is_complete(&self) -> bool {
        self.failures.is_empty() && !self.ids.is_empty() && (self.saw_end || self.stopped_at_known)
    }
}

/// Caminha o catálogo de UM tipo com o passo FIXO do `stride_at`.
///
/// `known` é o conjunto de `url_key` já na fila: quando `Some`, uma página
/// inteira de obras conhecidas incrementa `known_run`; ao atingir
/// `known_pages_to_stop` a rodada para (`stopped_at_known`). `None` = varredura
/// completa (sem corte incremental).
pub async fn walk_catalog(
    api: &dyn MicoApi,
    cfg: &MicoCrawlConfig,
    kind: MicoKind,
    known: Option<&HashSet<String>>,
    is_aborted: &(dyn Fn() -> bool + Sync),
) -> CatalogWalk {
    let mut walk = CatalogWalk::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut skip: u32 = 0;
    let mut empty_run: u32 = 0;
    let mut known_run: u32 = 0;

    while walk.pages < cfg.max_pages {
        if is_aborted() {
            break;
        }
        let mut page = None;
        let mut failed = false;
        // Reconsulta a MESMA página vazia: a API devolve vazio intermitente.
        for _ in 0..=cfg.empty_retries {
            if walk.pages >= cfg.max_pages || is_aborted() {
                break;
            }
            walk.pages += 1;
            match api
                .catalog_page(catalog_type(kind), catalog_id(kind), skip as usize)
                .await
            {
                Ok(catalog) => {
                    if catalog.count > 0 {
                        page = Some(catalog);
                        break;
                    }
                }
                Err(err) => {
                    walk.failures.push(format!("{err:?}"));
                    if walk.pages == 1 {
                        walk.first_page_failed = true;
                    }
                    // Sem `honor_retry_after` local: o throttle do cliente já
                    // registrou a espera e a próxima chamada dorme o gap.
                    failed = true;
                    break;
                }
            }
        }

        if !failed {
            match page {
                Some(catalog) => {
                    empty_run = 0;
                    let ids: Vec<String> = {
                        let mut novos = Vec::new();
                        for id in &catalog.ids {
                            if seen.insert(id.clone()) {
                                novos.push(id.clone());
                            }
                        }
                        novos
                    };
                    walk.ids.extend(ids);
                    let all_known = match known {
                        Some(set) => {
                            !catalog.ids.is_empty()
                                && catalog.ids.iter().all(|id| {
                                    let url = synthetic_url(kind, id, Some(&cfg.base_url));
                                    set.contains(&crawl_url_key(&url))
                                })
                        }
                        None => false,
                    };
                    known_run = if all_known { known_run + 1 } else { 0 };
                    if known_run >= cfg.known_pages_to_stop {
                        walk.stopped_at_known = true;
                        break;
                    }
                }
                None => {
                    empty_run += 1;
                    if empty_run >= cfg.end_after_empties {
                        walk.saw_end = true;
                        break;
                    }
                }
            }
        }

        // PASSO FIXO: o índice bruto do catálogo, nunca `metas.length`.
        skip = skip.saturating_add(stride_at(skip));
    }
    walk
}

/// Id do catálogo de cada tipo (`MicoFilmes`/`MicoSeries`).
pub fn catalog_id(kind: MicoKind) -> &'static str {
    match kind {
        MicoKind::Movie => crate::mico::MOVIE_CATALOG_ID,
        MicoKind::Series => crate::mico::SERIES_CATALOG_ID,
    }
}

/// Resultado da descoberta de UM tipo, pronto para o chamador enfileirar.
#[derive(Debug, Clone)]
pub struct KindDiscovery {
    pub urls: Vec<UrlRow>,
    pub failures: Vec<String>,
    /// Descoberta completa do tipo (régua do cursor: só com `complete` o TS
    /// deixava o incremental parar; aqui é também a régua do marcador).
    pub complete: bool,
    pub request_cost: u32,
    pub total_failure: bool,
    pub full_sweep: bool,
    pub saw_end: bool,
    /// Grava o marcador `full-sweep:<tipo>`: só numa completa que viu o FIM.
    pub mark_full_sweep: bool,
    pub state_key: String,
}

/// Descobre UM tipo. `last_full` vem do `crawl_state` e `known` do store (o
/// chamador carrega antes porque a rede não pode segurar o mutex do SQLite).
pub async fn discover_kind(
    api: &dyn MicoApi,
    cfg: &MicoCrawlConfig,
    kind: MicoKind,
    now: i64,
    last_full: Option<&str>,
    known: Option<&HashSet<String>>,
    is_aborted: &(dyn Fn() -> bool + Sync),
) -> KindDiscovery {
    let full_sweep = is_full_sweep(last_full, now, cfg.full_sweep_hours);
    let walk = walk_catalog(api, cfg, kind, known, is_aborted).await;
    let period_days = match kind {
        MicoKind::Movie => cfg.reread_days_movie,
        MicoKind::Series => cfg.reread_days_series,
    };
    let urls: Vec<UrlRow> = walk
        .ids
        .iter()
        .map(|tt| {
            let url = synthetic_url(kind, tt, Some(&cfg.base_url));
            UrlRow {
                site: cfg.site.clone(),
                url_key: crawl_url_key(&url),
                url,
                lastmod: bucket_lastmod(tt, now, period_days),
                kind: queue_kind(kind).to_string(),
                status: "pending".to_string(),
                imdb: Some(tt.clone()),
                tries: 0,
                next_at: 0,
                checked_at: 0,
                releases: 0,
                error: String::new(),
                progress: String::new(),
                added_at: now,
            }
        })
        .collect();
    let total_failure = walk.first_page_failed || urls.is_empty();
    let complete = walk.is_complete();
    KindDiscovery {
        urls,
        failures: walk.failures,
        complete,
        request_cost: walk.pages,
        total_failure,
        full_sweep,
        saw_end: walk.saw_end,
        mark_full_sweep: full_sweep && complete && walk.saw_end,
        state_key: full_sweep_key(kind),
    }
}

#[cfg(test)]
#[path = "mico_discovery_tests.rs"]
mod tests;
