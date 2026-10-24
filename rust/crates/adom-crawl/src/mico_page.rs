//! Leitura de página do Mico no motor Rust (Fase 6).
//!
//! O Mico não tem página HTML: a "página" da fila é a URL sintética
//! `<base>/crawl/(movie|series)/<tt>/` e o conteúdo é JSON de streams.
//! - FILME: uma requisição a `/stream/movie/<tt>.json`; o parse (hash 40 hex,
//!   título obrigatório, dedupe) é o MESMO `parse_mico_content` do TS.
//! - SÉRIE: metadados da Cinemeta (`episodes`/`episodeAired`) → episódios-alvo
//!   pela régua do `mico.rs` (`list_target_episodes`) → uma requisição por
//!   episódio, até `series_max_buttons` por passe. O progresso (`doneCards`) é
//!   MONOTÔNICO e sobrevive na coluna `progress`; o que sobra vira `partial` e
//!   o motor reenfileira.
//!
//! 4xx (exceto 429) vira `no-torrent` sem lançar — mesma semântica do
//! `fetchMicoStreams`; 429/5xx/rede sobe como erro retentável.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::json;

use crate::mico::{
    list_target_episodes, mico_episode_stream_url, mico_movie_stream_url, parse_mico_url, MicoKind,
    SeriesMeta, TargetEpisode,
};
use crate::mico_discovery::MicoCrawlConfig;
use crate::mico_net::api::MicoApi;
use crate::motor::types::{
    now_ms, CrawlReleaseGroup, CrawlResultStatus, CrawlWorkResult, PageEngine, PageFuture,
    PageOutcome,
};
use crate::page_engine::{release_from, to_work};
use crate::page_parser::parse_mico_json;
use crate::store::UrlRow;

/// Versão do `SeriesWorkProgress` (mesmo `v` do TS).
const PROGRESS_VERSION: u32 = 1;

/// Engine de página do Mico (ritmo próprio), atrás de [`PageEngine`].
pub struct MicoPageEngine {
    api: Arc<dyn MicoApi>,
    base_url: String,
    max_seasons: u32,
    max_buttons: u32,
}

impl MicoPageEngine {
    pub fn new(api: Arc<dyn MicoApi>, cfg: &MicoCrawlConfig) -> Self {
        Self {
            api,
            base_url: cfg.base_url.trim_end_matches('/').to_string(),
            max_seasons: cfg.series_max_seasons.max(1),
            max_buttons: cfg.series_max_buttons.max(1),
        }
    }

    async fn run(&self, row: &UrlRow) -> PageOutcome {
        let Some(parsed) = parse_mico_url(&row.url, Some(&self.base_url)) else {
            return PageOutcome::Failed(format!("mico: URL fora do padrão ({})", row.url));
        };
        let quer_serie = row.kind == "tv_show" || row.kind == "series";
        if (parsed.kind == MicoKind::Series) != quer_serie {
            // Kind divergente é erro SEM rede (paridade com o `mico.ts`).
            return PageOutcome::Failed(format!(
                "mico: kind divergente na fila ({} para {})",
                row.kind, parsed.imdb
            ));
        }
        match parsed.kind {
            MicoKind::Movie => self.movie(row, &parsed.imdb).await,
            MicoKind::Series => self.series(row, &parsed.imdb).await,
        }
    }

    async fn movie(&self, row: &UrlRow, tt: &str) -> PageOutcome {
        let Some(url) = mico_movie_stream_url(tt, Some(&self.base_url)) else {
            return PageOutcome::Failed(format!("mico: URL de stream inválida ({tt})"));
        };
        match self.api.get_json(&url).await {
            Ok(Some(body)) => {
                let mut work = to_work(row, parse_mico_json(&row.url, false, &body), 1);
                // O card do Mico é POR IMDb: a âncora é a URL, não a página.
                work.imdb = Some(tt.to_string());
                PageOutcome::Work(Box::new(work))
            }
            // 4xx: a obra não tem stream hoje; não prova host caído.
            Ok(None) => PageOutcome::Work(Box::new(no_torrent(row, tt, "movie", 1))),
            Err(err) => PageOutcome::Failed(format!("mico: {err:?}")),
        }
    }

    async fn series(&self, row: &UrlRow, tt: &str) -> PageOutcome {
        let meta: SeriesMeta = match self.api.series_meta(tt).await {
            Ok(Some(meta)) => meta,
            // Sem meta não dá para AFIRMAR que a série não tem episódios: é
            // falha transitória → erro retentável, nunca `no-torrent`.
            Ok(None) => {
                return PageOutcome::Failed(format!("mico: série sem meta da Cinemeta ({tt})"))
            }
            Err(err) => return PageOutcome::Failed(format!("mico: Cinemeta {err:?}")),
        };
        let now = now_ms();
        let targets = list_target_episodes(Some(&meta), self.max_seasons as usize, now);
        if targets.is_empty() {
            // Nenhum episódio já exibido dentro do teto de temporadas.
            return PageOutcome::Work(Box::new(no_torrent(row, tt, "series", 0)));
        }

        let resume = resume_cards(&row.progress);
        let mut done: HashSet<String> = resume.iter().cloned().collect();
        let total = targets.len() as u32;
        let mut groups: Vec<CrawlReleaseGroup> = Vec::new();
        let mut cost: u32 = 0;

        for TargetEpisode { season, episode } in &targets {
            let key = card_key(*season, *episode);
            if done.contains(&key) {
                continue;
            }
            if cost >= self.max_buttons {
                break; // teto de episódios deste passe
            }
            let Some(url) = mico_episode_stream_url(tt, *season, *episode, Some(&self.base_url))
            else {
                continue;
            };
            cost += 1; // conta a tentativa iniciada, inclusive a que falhar
            match self.api.get_json(&url).await {
                Ok(Some(body)) => {
                    let parsed = parse_mico_json(&url, true, &body);
                    if !parsed.releases.is_empty() {
                        groups.push(CrawlReleaseGroup {
                            season: Some(*season),
                            episode: Some(*episode),
                            releases: parsed.releases.iter().map(release_from).collect(),
                        });
                    }
                }
                // 4xx = episódio sem stream: concluído, sem grupo.
                Ok(None) => {}
                Err(err) => {
                    return PageOutcome::Failed(format!(
                        "mico: episódio {season}x{episode} {err:?}"
                    ))
                }
            }
            done.insert(key);
        }

        let progress = render_progress(&done, total);
        let pending = targets
            .iter()
            .filter(|ep| !done.contains(&card_key(ep.season, ep.episode)))
            .count() as u32;
        if pending > 0 {
            let error = format!(
                "series_truncated: teto de episódios por passe ({} de {total} feitos, {pending} pendentes)",
                done.len()
            );
            return PageOutcome::Work(Box::new(series_result(
                row,
                tt,
                CrawlResultStatus::Partial,
                groups,
                Some(progress),
                error,
                cost,
            )));
        }
        if !groups.is_empty() {
            return PageOutcome::Work(Box::new(series_result(
                row,
                tt,
                CrawlResultStatus::Done,
                groups,
                Some(progress),
                String::new(),
                cost,
            )));
        }
        // Sem release no passe FINAL: com progresso anterior a série já foi
        // colhida (`conclusão por retomada`); sem resume, é `no-torrent`.
        if !resume.is_empty() {
            return PageOutcome::Work(Box::new(series_result(
                row,
                tt,
                CrawlResultStatus::Done,
                Vec::new(),
                Some(progress),
                String::new(),
                cost,
            )));
        }
        PageOutcome::Work(Box::new(no_torrent(row, tt, "series", cost)))
    }
}

impl PageEngine for MicoPageEngine {
    fn is_ready(&self) -> bool {
        true
    }

    fn execute<'a>(&'a self, row: &'a UrlRow) -> PageFuture<'a> {
        Box::pin(self.run(row))
    }
}

/// Engine roteadora: site `own_pace` vai para a engine do Mico; o resto segue
/// no motor HTML. É este roteamento que impede o Mico de cair no fetch de
/// página (a cinta de segurança do `CrawlPageEngine` continua valendo).
pub struct RoutedPageEngine {
    html: Arc<dyn PageEngine>,
    mico: Arc<dyn PageEngine>,
}

impl RoutedPageEngine {
    pub fn new(html: Arc<dyn PageEngine>, mico: Arc<dyn PageEngine>) -> Self {
        Self { html, mico }
    }
}

impl PageEngine for RoutedPageEngine {
    fn is_ready(&self) -> bool {
        self.html.is_ready() || self.mico.is_ready()
    }

    fn execute<'a>(&'a self, row: &'a UrlRow) -> PageFuture<'a> {
        let alvo = if crate::site_profiles::is_own_pace(&row.site) {
            &self.mico
        } else {
            &self.html
        };
        alvo.execute(row)
    }
}

/// Chave de card do progresso (`"S:E"`), como o TS.
fn card_key(season: u32, episode: u32) -> String {
    format!("{season}:{episode}")
}

/// `doneCards` da coluna `progress`. Ilegível/ausente = primeiro passe.
fn resume_cards(progress: &str) -> Vec<String> {
    if progress.trim().is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<serde_json::Value>(progress)
        .ok()
        .and_then(|v| v.get("doneCards").and_then(|d| d.as_array()).cloned())
        .map(|cards| {
            cards
                .iter()
                .filter_map(|c| c.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Serializa o `SeriesWorkProgress` (`{v,doneCards,totalCards}`).
fn render_progress(done: &HashSet<String>, total: u32) -> String {
    let mut cards: Vec<&String> = done.iter().collect();
    cards.sort(); // determinístico; a semântica é conjunto
    json!({
        "v": PROGRESS_VERSION,
        "doneCards": cards,
        "totalCards": total,
    })
    .to_string()
}

/// Resultado `no-torrent` de uma obra do Mico.
fn no_torrent(row: &UrlRow, tt: &str, kind: &str, cost: u32) -> CrawlWorkResult {
    CrawlWorkResult {
        url: row.url.clone(),
        url_key: row.url_key.clone(),
        site: row.site.clone(),
        status: CrawlResultStatus::NoTorrent,
        imdb: Some(tt.to_string()),
        title: None,
        year: None,
        kind: kind.to_string(),
        releases: Vec::new(),
        groups: Vec::new(),
        unlocated: Vec::new(),
        progress: None,
        request_cost: cost,
        error: String::new(),
        gate: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn series_result(
    row: &UrlRow,
    tt: &str,
    status: CrawlResultStatus,
    groups: Vec<CrawlReleaseGroup>,
    progress: Option<String>,
    error: String,
    cost: u32,
) -> CrawlWorkResult {
    CrawlWorkResult {
        url: row.url.clone(),
        url_key: row.url_key.clone(),
        site: row.site.clone(),
        status,
        imdb: Some(tt.to_string()),
        title: None,
        year: None,
        kind: "series".to_string(),
        releases: Vec::new(),
        groups,
        unlocated: Vec::new(),
        progress,
        request_cost: cost,
        error,
        gate: None,
    }
}

#[cfg(test)]
#[path = "mico_page_tests.rs"]
mod tests;
