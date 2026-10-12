//! Porte de `filterRelevantRaw` e `filterRelevantRawForYear`
//! (`src/utils/release-filters.ts`): o corte cru por item, com o motivo de cada
//! rejeição (`RelevanceRejectReason`), na MESMA ordem em que o TS dispara o
//! `onRejected`.
//!
//! Config não é lida aqui: o chamador passa `RelevanceSettings`. No TS isso
//! vem de `config.search` (`preHomeReleaseCut`, `preHomeReleaseMarginMs`,
//! `titlePrecisionTailCut`) e de `Date.now()`; o golden fixa esses valores por
//! caso para medir o mesmo ramo nos dois lados.
//!
//! O TS trata o ano de catálogo como `String(year ?? '')` e o chamador passa
//! esse texto em `year` (`""` para ausente). Ano dual (`altYear`) vale o que
//! passar por QUALQUER um dos dois anos.

mod series_markers;

use std::collections::HashSet;

use crate::admits_multi_work_pack;
use crate::franchise_extension_contradicts;
use crate::is_non_feature;
use crate::magnet_display_name;
use crate::magnet_season_contradicts;
use crate::magnet_year_contradicts;
use crate::matches_br_title;
use crate::matches_episode;
use crate::matches_episode_work_identity;
use crate::matches_global_series_no_marker;
use crate::matches_name;
use crate::matches_short_name_identity;
use crate::matches_title_structure;
use crate::matching_decisions::{
    adaptation_identity_contradicts, first_year_in, named_sequel_contradicts, year_contradicts,
};
use crate::pre_home_release_contradicts;
use crate::short_name_identity;
use crate::short_name_tail_contradicts;
use crate::title_tokens;
use crate::ShortNameIdentity;
use series_markers::{movie_carries_series_marker, series_release_looks_like_movie};

/// Motivo de rejeição, na mesma grafia do TS (`RelevanceRejectReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelevanceRejectReason {
    Title,
    MagnetYear,
    NamedSequel,
    Identity,
    Episode,
    SeriesWork,
    MovieIsSeries,
    SeriesIsMovie,
    PreHomeRelease,
    NonFeature,
}

impl RelevanceRejectReason {
    /// Rótulo idêntico ao literal do TS (`'magnet-year'`, `'series-is-movie'`…).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::MagnetYear => "magnet-year",
            Self::NamedSequel => "named-sequel",
            Self::Identity => "identity",
            Self::Episode => "episode",
            Self::SeriesWork => "series-work",
            Self::MovieIsSeries => "movie-is-series",
            Self::SeriesIsMovie => "series-is-movie",
            Self::PreHomeRelease => "pre-home-release",
            Self::NonFeature => "non-feature",
        }
    }
}

/// Campos de `RawItem` que a relevância lê. `title_pascal` é o `Title`.
/// Strings vazias valem como ausentes, como o `||` do JS.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RelevanceItem {
    pub title: Option<String>,
    pub title_pascal: Option<String>,
    pub magnet: Option<String>,
    pub magnet_uri: Option<String>,
    pub guid: Option<String>,
    pub is_br: bool,
}

impl RelevanceItem {
    /// `item.title || item.Title || ''`.
    fn title_text(&self) -> &str {
        truthy(self.title.as_deref())
            .or_else(|| truthy(self.title_pascal.as_deref()))
            .unwrap_or("")
    }

    /// `item.magnet || item.MagnetUri` (sem `Guid`, como `packYearSource`).
    fn magnet_or_uri(&self) -> Option<&str> {
        truthy(self.magnet.as_deref()).or_else(|| truthy(self.magnet_uri.as_deref()))
    }
}

/// Opções de `filterRelevantRaw` (`MatchOptions`). `year`/`alt_year` já vêm como
/// texto (`String(x ?? '')`); `multi_work_root` é a raiz da coleção, se houver.
#[derive(Debug, Clone, Copy)]
pub struct RelevanceQuery<'a> {
    pub names: &'a [String],
    pub year: &'a str,
    pub alt_year: Option<&'a str>,
    pub is_series: bool,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub multi_work_root: Option<&'a str>,
    pub home_release_at: Option<i64>,
}

/// Config que o TS lê em tempo de chamada (e o relógio). Fica fora da query
/// porque é do processo, não da busca.
#[derive(Debug, Clone, Copy)]
pub struct RelevanceSettings {
    /// `Date.now()` do TS, em ms.
    pub now_ms: i64,
    /// `config.search.preHomeReleaseCut`.
    pub pre_home_release_cut: bool,
    /// `config.search.preHomeReleaseMarginMs`.
    pub pre_home_release_margin_ms: i64,
    /// `config.search.titlePrecisionTailCut` (default `true`).
    pub title_precision_tail_cut: bool,
}

/// Resultado: índices mantidos e, em ordem de disparo, `(índice, motivo)` dos
/// rejeitados (o `onRejected` do TS).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RelevanceOutcome {
    pub kept: Vec<usize>,
    pub rejected: Vec<(usize, RelevanceRejectReason)>,
}

fn truthy(s: Option<&str>) -> Option<&str> {
    s.filter(|v| !v.is_empty())
}

/// `filterRelevantRaw`: com ano dual, vale o que passar por QUALQUER um dos dois.
pub fn filter_relevant_raw(
    items: &[RelevanceItem],
    query: &RelevanceQuery,
    settings: &RelevanceSettings,
) -> RelevanceOutcome {
    let alt = first_year_in(query.alt_year.unwrap_or(""));
    if alt == 0 || alt == first_year_in(query.year) {
        return filter_relevant_raw_for_year(items, query, settings);
    }
    let main = decisions_for_year(items, query, settings);
    let alt_query = RelevanceQuery {
        year: query.alt_year.unwrap_or(""),
        ..*query
    };
    let other = decisions_for_year(items, &alt_query, settings);
    let mut outcome = RelevanceOutcome::default();
    for (i, (main_reason, other_reason)) in main.iter().zip(&other).enumerate() {
        match (main_reason, other_reason) {
            (None, _) | (_, None) => outcome.kept.push(i),
            // O motivo vem do passe do ano alternativo, como no `reasons` do TS.
            (Some(_), Some(reason)) => outcome.rejected.push((i, *reason)),
        }
    }
    outcome
}

/// `filterRelevantRawForYear`: o corte pelo ano de `query.year`, sem ano dual.
/// `alt_year` é ignorado aqui, como no TS.
pub fn filter_relevant_raw_for_year(
    items: &[RelevanceItem],
    query: &RelevanceQuery,
    settings: &RelevanceSettings,
) -> RelevanceOutcome {
    let mut outcome = RelevanceOutcome::default();
    for (i, decision) in decisions_for_year(items, query, settings)
        .into_iter()
        .enumerate()
    {
        match decision {
            None => outcome.kept.push(i),
            Some(reason) => outcome.rejected.push((i, reason)),
        }
    }
    outcome
}

/// Decisão por item na ordem do TS: `None` = mantido, `Some(motivo)` = rejeitado.
/// Sem nomes, nada é filtrado (o TS devolve a lista inteira).
fn decisions_for_year(
    items: &[RelevanceItem],
    query: &RelevanceQuery,
    settings: &RelevanceSettings,
) -> Vec<Option<RelevanceRejectReason>> {
    if query.names.is_empty() {
        return vec![None; items.len()];
    }
    let decider = Decider::new(*query, *settings);
    items.iter().map(|item| decider.reject(item)).collect()
}

/// Estado que depende só dos nomes e do ano, calculado uma vez por chamada.
struct Decider<'a> {
    query: RelevanceQuery<'a>,
    settings: RelevanceSettings,
    /// Ano de catálogo (`Number(String(year).match(...) || 0)`).
    catalog_year: i64,
    /// Tokens de todos os nomes, com vazios removidos (`universe` do TS).
    universe: Vec<String>,
    universe_set: HashSet<String>,
    /// Um por nome, na mesma ordem de `query.names`.
    checks: Vec<ShortNameIdentity>,
    names_str: Vec<&'a str>,
}

impl<'a> Decider<'a> {
    fn new(query: RelevanceQuery<'a>, settings: RelevanceSettings) -> Self {
        let universe: Vec<String> = query
            .names
            .iter()
            .flat_map(|n| title_tokens(n))
            .filter(|t| !t.is_empty())
            .collect();
        let universe_set = universe.iter().cloned().collect();
        let checks = query.names.iter().map(|n| short_name_identity(n)).collect();
        let names_str = query.names.iter().map(String::as_str).collect();
        Self {
            query,
            settings,
            catalog_year: first_year_in(query.year),
            universe,
            universe_set,
            checks,
            names_str,
        }
    }

    fn reject(&self, item: &RelevanceItem) -> Option<RelevanceRejectReason> {
        let q = &self.query;
        let title = item.title_text();
        let tokens = title_tokens(title);
        let magnet = item.magnet.as_deref();
        let magnet_uri = item.magnet_uri.as_deref();
        let guid = item.guid.as_deref();
        let dn = magnet_display_name(magnet, magnet_uri, guid);
        let dn = dn.as_str();

        if !self.title_matches(item, title, &tokens, dn) {
            let admitted = admits_multi_work_pack(
                title,
                item.magnet_or_uri().unwrap_or(""),
                q.multi_work_root,
                q.year,
                q.is_series,
                q.names,
            );
            return if admitted {
                None
            } else {
                Some(RelevanceRejectReason::Title)
            };
        }

        // Série: contaminação de identidade por adaptação (One Piece 2023/2026).
        let display = format!("{title} {dn}");
        if q.is_series && adaptation_identity_contradicts(q.season.is_some(), &display, q.year) {
            return Some(RelevanceRejectReason::Identity);
        }

        // Filme: release de SÉRIE sem temporada pedida (ver o comentário do TS).
        if !q.is_series && q.season.is_none() && movie_carries_series_marker(&display, q.names) {
            return Some(RelevanceRejectReason::MovieIsSeries);
        }

        // Filme: sequela nomeada com ano exato diferente, ano do magnet, janela
        // pré-lançamento doméstico.
        if !q.is_series && q.season.is_none() {
            if self.catalog_year != 0
                && !item.is_br
                && named_sequel_contradicts(&tokens, &self.universe, &self.catalog_year.to_string())
            {
                return Some(RelevanceRejectReason::NamedSequel);
            }
            if self.catalog_year != 0
                && magnet_year_contradicts(magnet, magnet_uri, guid, self.catalog_year)
            {
                return Some(RelevanceRejectReason::MagnetYear);
            }
            if pre_home_release_contradicts(
                &[title, dn],
                q.home_release_at,
                self.settings.now_ms,
                self.settings.pre_home_release_cut,
                self.settings.pre_home_release_margin_ms,
            ) {
                return Some(RelevanceRejectReason::PreHomeRelease);
            }
        }

        if is_non_feature(&[title, dn], &self.names_str) {
            return Some(RelevanceRejectReason::NonFeature);
        }

        // Série: espelho do veto acima, release de FILME homônimo.
        if q.is_series && q.season.is_some() && series_release_looks_like_movie(title, dn, q.year) {
            return Some(RelevanceRejectReason::SeriesIsMovie);
        }

        if let (true, Some(season)) = (q.is_series, q.season) {
            if magnet_season_contradicts(magnet, magnet_uri, guid, season, q.episode) {
                return Some(RelevanceRejectReason::Episode);
            }
        }

        let (Some(season), Some(episode)) = (q.season, q.episode) else {
            return None;
        };
        if !matches_episode(title, Some(season), Some(episode)) {
            return Some(RelevanceRejectReason::Episode);
        }
        if item.is_br {
            return None;
        }
        let cut = self.settings.title_precision_tail_cut;
        if !matches_global_series_no_marker(title, &tokens, &self.universe, cut) {
            return Some(RelevanceRejectReason::SeriesWork);
        }
        None
    }

    /// `titleMatches` do TS: algum nome casa o título. BR só passa pelo
    /// `matchesBrTitle`; global passa pela cadeia estrita inteira.
    fn title_matches(
        &self,
        item: &RelevanceItem,
        title: &str,
        tokens: &[String],
        dn: &str,
    ) -> bool {
        let q = &self.query;
        let cut = self.settings.title_precision_tail_cut;
        q.names.iter().zip(&self.checks).any(|(name, check)| {
            if item.is_br {
                return matches_br_title(
                    title,
                    name,
                    q.year,
                    q.is_series,
                    Some(q.names),
                    Some(tokens),
                    Some(&self.universe),
                    cut,
                );
            }
            matches_name(title, name, Some(tokens))
                && matches_short_name_identity(title, check, Some(tokens), dn)
                && (if q.is_series {
                    !year_contradicts(tokens, q.year, true)
                } else {
                    matches_title_structure(title, name, q.year, false, Some(tokens))
                        && !franchise_extension_contradicts(
                            title,
                            Some(tokens),
                            name,
                            q.names,
                            q.year,
                        )
                        && !short_name_tail_contradicts(
                            tokens,
                            short_name_tail_token(check),
                            &self.universe_set,
                        )
                })
                && matches_episode_work_identity(
                    title,
                    Some(q.names),
                    Some(tokens),
                    Some(&self.universe),
                    cut,
                )
        })
    }
}

/// `shortNameTailContradicts` só age com UM token no `run` do nome prefixado:
/// o TS faz `check.run[0]` nesse caso e devolve `false` nos demais.
fn short_name_tail_token(check: &ShortNameIdentity) -> Option<&str> {
    match check {
        ShortNameIdentity::Prefix { run, .. } if run.len() == 1 => Some(run[0].as_str()),
        _ => None,
    }
}
