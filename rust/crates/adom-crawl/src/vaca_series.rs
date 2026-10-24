//! Locação e evidências da Vaca (decodeEvidence, seasonFromCardSlug, declaredSeriesLocation, groupSeriesReleases, packSignature).
//!
//! Migração fiel de:
//! - `src/providers/crawl-sites/vaca-series-locate.ts`
//! - `src/providers/crawl-sites/vaca-series.ts` (regras puras de packSignature e re-exports)

use std::sync::OnceLock;

use adom_core::{
    live_action_year_contradicts, parse_title_season_episode, release_work_targets,
    ParsedSeasonEpisode, WorkTarget,
};

/// Locação de série: temporada e episódio opcionais.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct SeriesLocation {
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

/// Evidência disponível na onda em que a request de um botão nasce.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LinkEvidence {
    /// Slug `temporada-N`/ordinal do card (`season_from_card_slug`).
    pub card_season: Option<i64>,
    /// Texto da âncora do card ("Temporada 5", "Stranger Things 4", "East Blue1").
    pub card_title: String,
    pub is_batch: bool,
    /// Título real do batch ("BATCH – Reacher S01").
    pub real_title: Option<String>,
    /// Nome REAL do torrent (`magnet_display_name`), ou None.
    pub dn: Option<String>,
    /// Episódio da máquina de episódios (marcador `ss-ep-num`).
    pub link_episode: Option<i64>,
}

/// Representação padrão de release crua para o raspador.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct CrawlRelease {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, rename = "Title")]
    pub title_pascal: Option<String>,
    #[serde(default)]
    pub magnet: Option<String>,
    #[serde(default, rename = "MagnetUri")]
    pub magnet_uri: Option<String>,
    #[serde(default, rename = "Guid")]
    pub guid: Option<String>,
    #[serde(default, rename = "infoHash")]
    pub info_hash: Option<String>,
    #[serde(default)]
    pub indexer: Option<String>,
    #[serde(default)]
    pub tracker: Option<String>,
    #[serde(default, rename = "isBr")]
    pub is_br: Option<bool>,
    #[serde(default)]
    pub seeders: Option<i64>,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub season: Option<i64>,
    #[serde(default)]
    pub episode: Option<i64>,
}

/// Trait para itens de release usados no agrupamento.
pub trait CrawlReleaseItem: Clone {
    fn title(&self) -> &str;
    fn magnet_display_name(&self) -> String;
}

impl CrawlReleaseItem for CrawlRelease {
    fn title(&self) -> &str {
        self.title
            .as_deref()
            .or(self.title_pascal.as_deref())
            .unwrap_or("")
    }

    fn magnet_display_name(&self) -> String {
        adom_core::magnet_display_name(
            self.magnet.as_deref(),
            self.magnet_uri.as_deref(),
            self.guid.as_deref(),
        )
    }
}

impl<T: CrawlReleaseItem> CrawlReleaseItem for &T {
    fn title(&self) -> &str {
        (*self).title()
    }

    fn magnet_display_name(&self) -> String {
        (*self).magnet_display_name()
    }
}

/// Entrada de release com a locação pedida pelo card que a produziu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesReleaseEntry<T = CrawlRelease> {
    pub release: T,
    pub request: SeriesLocation,
}

/// Opções para agrupamento de releases de série.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GroupSeriesOptions<'a> {
    pub year: Option<&'a str>,
    pub by_declared_location: bool,
}

/// Grupo de releases por locação declarada.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CrawlReleaseGroup<T = CrawlRelease> {
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub releases: Vec<T>,
}

mod evidence;
pub use evidence::*;

fn season_or_null(n: i64) -> Option<i64> {
    if (1..=99).contains(&n) {
        Some(n)
    } else {
        None
    }
}

/// Locação que um parse declara, ou `None` quando é silencioso.
fn location_of_parse(p: &ParsedSeasonEpisode) -> Option<SeriesLocation> {
    if p.complete || p.seasons.len() > 1 {
        return Some(SeriesLocation {
            season: None,
            episode: None,
        });
    }
    if p.seasons.len() == 1 {
        let episode = if p.episodes.len() == 1 {
            Some(p.episodes[0])
        } else {
            None
        };
        return Some(SeriesLocation {
            season: Some(p.seasons[0]),
            episode,
        });
    }
    None
}

/// O parse declara raiz (complete ou mais de uma temporada)?
fn parse_declares_root(p: &ParsedSeasonEpisode) -> bool {
    p.complete || p.seasons.len() > 1
}

/// Última "palavra" numérica de 1-2 dígitos do título ("East Blue1" → 1).
pub fn trailing_season_of(title: &str) -> Option<i64> {
    let text = title.trim();
    if text.is_empty() {
        return None;
    }
    static RE_YEAR: OnceLock<regex::Regex> = OnceLock::new();
    let re_year = RE_YEAR.get_or_init(|| regex::Regex::new(r"\d{3,}\s*$").unwrap());
    if re_year.is_match(text) {
        return None;
    }
    static RE_TRAILING: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_trailing =
        RE_TRAILING.get_or_init(|| fancy_regex::Regex::new(r"(?<!\d)(\d{1,2})\s*$").unwrap());
    let caps = re_trailing.captures(text).ok()??;
    let n = caps.get(1)?.as_str().parse::<i64>().ok()?;
    season_or_null(n)
}

/// Onde o botão nasce (regras 1 a 5 de precedência).
pub fn declared_series_location(e: &LinkEvidence) -> SeriesLocation {
    // Regra 1 — dn é conteúdo: o nome REAL do torrent vence qualquer página.
    let dn = decode_evidence(e.dn.as_deref().unwrap_or(""));
    if !dn.trim().is_empty() {
        let from_dn = location_of_parse(&parse_title_season_episode(&dn));
        if let Some(loc) = from_dn {
            return loc;
        }
    }

    // Episódio da página: só vale em card POR-EPISÓDIO (batch não tem episódio).
    let page_episode = if e.is_batch { None } else { e.link_episode };

    // Regra 2 — o rótulo do próprio card/batch declara.
    let candidates = [e.real_title.as_deref(), Some(e.card_title.as_str())];
    for candidate in candidates {
        let Some(candidate) = candidate else { continue };
        let text = decode_evidence(candidate);
        if text.trim().is_empty() {
            continue;
        }
        let p = parse_title_season_episode(&text);
        if parse_declares_root(&p) {
            return SeriesLocation {
                season: None,
                episode: None,
            };
        }
        if p.seasons.len() == 1 {
            return SeriesLocation {
                season: Some(p.seasons[0]),
                episode: page_episode,
            };
        }
    }

    // Regra 3 — slug do card: evidência da página, só quando rótulo é silencioso.
    if let Some(card_season) = e.card_season {
        return SeriesLocation {
            season: Some(card_season),
            episode: page_episode,
        };
    }

    // Regra 4 — última defesa sem dn: dígito final do card ("East Blue1").
    let trailing = trailing_season_of(&decode_evidence(&e.card_title));
    if let Some(trailing) = trailing {
        return SeriesLocation {
            season: Some(trailing),
            episode: page_episode,
        };
    }

    // Regra 5 — nada declara: raiz conservadora.
    SeriesLocation {
        season: None,
        episode: None,
    }
}

/// Agrupa releases por locação declarada (título × dn).
pub fn group_series_releases<T: CrawlReleaseItem + Clone>(
    entries: &[SeriesReleaseEntry<T>],
    opts: &GroupSeriesOptions,
) -> Vec<CrawlReleaseGroup<T>> {
    let mut groups: Vec<CrawlReleaseGroup<T>> = Vec::new();
    let year_str = opts.year.unwrap_or("");

    for entry in entries {
        let title = decode_evidence(entry.release.title());
        let dn_raw = entry.release.magnet_display_name();
        let dn_decoded = decode_evidence(&dn_raw);
        let dn = if dn_decoded.is_empty() {
            None
        } else {
            Some(dn_decoded.as_str())
        };

        let check_text = format!("{} {}", title, dn.unwrap_or(""));
        if live_action_year_contradicts(&check_text, year_str) {
            continue;
        }

        let targets: Vec<WorkTarget> = if opts.by_declared_location {
            vec![WorkTarget {
                season: entry.request.season,
                episode: entry.request.episode,
            }]
        } else {
            release_work_targets(
                &title,
                WorkTarget {
                    season: entry.request.season,
                    episode: entry.request.episode,
                },
                dn,
                "",
            )
        };

        for target in targets {
            if let Some(group) = groups
                .iter_mut()
                .find(|g| g.season == target.season && g.episode == target.episode)
            {
                group.releases.push(entry.release.clone());
            } else {
                groups.push(CrawlReleaseGroup {
                    season: target.season,
                    episode: target.episode,
                    releases: vec![entry.release.clone()],
                });
            }
        }
    }

    // Ordem determinística: episódio > temporada > raiz
    groups.sort_by(|a, b| match (a.season.is_none(), b.season.is_none()) {
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        _ => {
            let s_a = a.season.unwrap_or(0);
            let s_b = b.season.unwrap_or(0);
            if s_a != s_b {
                s_a.cmp(&s_b)
            } else {
                let e_a = a.episode.unwrap_or(-1);
                let e_b = b.episode.unwrap_or(-1);
                e_a.cmp(&e_b)
            }
        }
    });

    groups
}

/// Dados de link para assinatura de pack.
#[derive(Debug, Clone, Default)]
pub struct PackSignatureInput<'a> {
    pub quality: Option<&'a str>,
    pub audio: Option<&'a str>,
    pub size: Option<&'a str>,
    pub episode: Option<i64>,
}

/// Assinatura de botão de PACK (sem episódio) com tamanho real.
pub fn pack_signature(link: &PackSignatureInput) -> Option<String> {
    if link.episode.is_some() {
        return None;
    }
    let raw_size = link.size.unwrap_or("");
    let mut size = String::with_capacity(raw_size.len());
    for c in raw_size.chars() {
        if !c.is_whitespace() {
            if c == ',' {
                size.push('.');
            } else {
                size.extend(c.to_lowercase());
            }
        }
    }
    if !size.chars().any(|c| c.is_ascii_digit()) {
        return None;
    }
    if is_one_kb_sentinel(&size) {
        return None;
    }
    let q = link.quality.unwrap_or("-");
    let a = link.audio.unwrap_or("-");
    Some(format!("s:{q}|{a}|{size}"))
}

/// Helper para chamada direta de `pack_signature`.
pub fn pack_signature_parts(
    quality: Option<&str>,
    audio: Option<&str>,
    size: Option<&str>,
    episode: Option<i64>,
) -> Option<String> {
    pack_signature(&PackSignatureInput {
        quality,
        audio,
        size,
        episode,
    })
}

fn is_one_kb_sentinel(size: &str) -> bool {
    if !size.ends_with("kb") {
        return false;
    }
    let num_part = &size[..size.len() - 2];
    if num_part == "1" {
        return true;
    }
    if let Some(rest) = num_part.strip_prefix("1.") {
        return !rest.is_empty() && rest.chars().all(|c| c == '0');
    }
    false
}

#[cfg(test)]
#[path = "vaca_series_tests.rs"]
mod tests;
