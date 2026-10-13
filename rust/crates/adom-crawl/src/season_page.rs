//! Agrupamentos de temporada e séries (pageSeasonOf, seasonPageGroups, seriesRowGroups, unlocatedReleases).
//!
//! Migração fiel de `src/providers/crawl-sites/season-page.ts`.

use std::sync::OnceLock;

use adom_core::parse_title_season_episode;

use crate::shared::decode_uri_component;
use crate::vaca_series::{
    declared_series_location, decode_evidence, group_series_releases, CrawlRelease,
    CrawlReleaseGroup, CrawlReleaseItem, GroupSeriesOptions, LinkEvidence, SeriesReleaseEntry,
};

/// Informações da página de temporada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeasonPageInfo<'a> {
    pub season: Option<i64>,
    pub title: &'a str,
}

/// Uma linha de release de página que agrega temporadas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeriesRow<T = CrawlRelease> {
    pub release: T,
    pub row_season: Option<i64>,
}

/// Temporada ÚNICA que o texto declara; `None` se nenhuma ou mais de uma.
fn single_season(text: &str) -> Option<i64> {
    let evidence = decode_evidence(text);
    let parsed = parse_title_season_episode(&evidence);
    if parsed.seasons.len() == 1 && !parsed.complete {
        Some(parsed.seasons[0])
    } else {
        None
    }
}

/// Temporada do POST: o `h1` primeiro ("Better Call Saul 4ª Temporada"), o
/// slug como reserva (`/kingdom-1a-temporada-720phdtv-2014-…/`). `None` quando
/// nenhum dos dois declara UMA temporada.
pub fn page_season_of(h1: &str, url: &str) -> Option<i64> {
    if let Some(from_title) = single_season(h1) {
        return Some(from_title);
    }
    let parsed_url = if let Ok(u) = url::Url::parse(url) {
        u
    } else if let Ok(u) =
        url::Url::parse(&format!("http://localhost/{}", url.trim_start_matches('/')))
    {
        u
    } else {
        return None;
    };
    let decoded_path = decode_uri_component(parsed_url.path())?;
    static RE_SLUG_SEP: OnceLock<regex::Regex> = OnceLock::new();
    let re_slug_sep = RE_SLUG_SEP.get_or_init(|| regex::Regex::new(r"[-_/]+").unwrap());
    let slug = re_slug_sep.replace_all(&decoded_path, " ");
    single_season(&slug)
}

/// Episódio do rótulo do botão.
pub fn label_episode(title: &str, page_season: Option<i64>) -> Option<i64> {
    let own = parse_title_season_episode(&decode_evidence(title));
    if own.episodes.len() == 1 {
        return Some(own.episodes[0]);
    }
    let page_season = page_season?;
    if !own.seasons.is_empty() || own.complete {
        return None;
    }
    let with_season_text = format!("{page_season}ª Temporada {title}");
    let with_season = parse_title_season_episode(&decode_evidence(&with_season_text));
    let same_season = with_season.seasons.len() == 1 && with_season.seasons[0] == page_season;
    if same_season && with_season.episodes.len() == 1 {
        Some(with_season.episodes[0])
    } else {
        None
    }
}

fn dn_declares_season<T: CrawlReleaseItem>(release: &T) -> bool {
    let dn = release.magnet_display_name();
    if dn.is_empty() {
        return false;
    }
    let parsed = parse_title_season_episode(&decode_evidence(&dn));
    !parsed.seasons.is_empty()
}

/// Junta grupos da mesma locação, na ordem do `group_series_releases` (raiz por último).
fn merge_groups<T: Clone>(groups: Vec<CrawlReleaseGroup<T>>) -> Vec<CrawlReleaseGroup<T>> {
    let mut by_key: Vec<CrawlReleaseGroup<T>> = Vec::new();
    for g in groups {
        if let Some(existing) = by_key
            .iter_mut()
            .find(|x| x.season == g.season && x.episode == g.episode)
        {
            existing.releases.extend(g.releases);
        } else {
            by_key.push(g);
        }
    }
    by_key.sort_by(|a, b| match (a.season.is_none(), b.season.is_none()) {
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
    by_key
}

/// Grupos por locação dos botões de UMA página de temporada.
pub fn season_page_groups<T: CrawlReleaseItem + Clone>(
    releases: &[T],
    page: &SeasonPageInfo,
) -> Vec<CrawlReleaseGroup<T>> {
    let entries: Vec<SeriesReleaseEntry<T>> = releases
        .iter()
        .map(|release| {
            let dn_str = release.magnet_display_name();
            let dn = if dn_str.is_empty() { None } else { Some(dn_str) };
            let request = declared_series_location(&LinkEvidence {
                card_season: page.season,
                card_title: page.title.to_string(),
                is_batch: false,
                real_title: None,
                dn,
                link_episode: label_episode(release.title(), page.season),
            });
            SeriesReleaseEntry {
                release: release.clone(),
                request,
            }
        })
        .collect();

    let by_dn: Vec<SeriesReleaseEntry<T>> = entries
        .iter()
        .filter(|e| dn_declares_season(&e.release))
        .cloned()
        .collect();
    let rest: Vec<SeriesReleaseEntry<T>> = entries
        .iter()
        .filter(|e| !dn_declares_season(&e.release))
        .cloned()
        .collect();

    let mut combined = group_series_releases(
        &by_dn,
        &GroupSeriesOptions {
            year: None,
            by_declared_location: true,
        },
    );
    combined.extend(group_series_releases(
        &rest,
        &GroupSeriesOptions {
            year: None,
            by_declared_location: false,
        },
    ));
    merge_groups(combined)
}

/// Grupos por locação das LINHAS de uma página que AGREGA temporadas (ex: RedeTorrent).
pub fn series_row_groups<T: CrawlReleaseItem + Clone>(
    rows: &[SeriesRow<T>],
) -> Vec<CrawlReleaseGroup<T>> {
    let mut entries = Vec::new();
    for row in rows {
        let dn_str = row.release.magnet_display_name();
        let dn = if dn_str.is_empty() { None } else { Some(dn_str) };
        let request = declared_series_location(&LinkEvidence {
            card_season: row.row_season,
            card_title: String::new(),
            is_batch: false,
            real_title: None,
            dn,
            link_episode: None,
        });
        if request.season.is_none() {
            continue;
        }
        entries.push(SeriesReleaseEntry {
            release: row.release.clone(),
            request,
        });
    }
    group_series_releases(
        &entries,
        &GroupSeriesOptions {
            year: None,
            by_declared_location: true,
        },
    )
}

/// Releases que nenhum grupo do `series_row_groups` locou (sem temporada no `dn=`).
pub fn unlocated_releases<T: PartialEq + Clone>(
    releases: &[T],
    groups: &[CrawlReleaseGroup<T>],
) -> Vec<T> {
    releases
        .iter()
        .filter(|rel| !groups.iter().any(|g| g.releases.contains(rel)))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_page_season_of() {
        assert_eq!(
            page_season_of(
                "Better Call Saul 4ª Temporada",
                "https://site.com/better-call-saul/"
            ),
            Some(4)
        );
        assert_eq!(
            page_season_of(
                "Kingdom",
                "https://site.com/kingdom-1a-temporada-720phdtv-2014/"
            ),
            Some(1)
        );
        assert_eq!(
            page_season_of("The Boys", "https://site.com/the-boys-4a-temporada-2024/"),
            Some(4)
        );
        assert_eq!(
            page_season_of(
                "Community 1ª a 4ª Temporada",
                "https://site.com/community-series/"
            ),
            None
        );
        assert_eq!(
            page_season_of("Inception 2010", "https://site.com/inception-2010/"),
            None
        );
    }

    #[test]
    fn test_label_episode() {
        // own já tem episódio único -> devolve o episódio
        assert_eq!(
            label_episode("The Boys E01 [1080p WEB-DL DUBLADO]", Some(4)),
            Some(1)
        );
        assert_eq!(
            label_episode("Lanternas 1ª Temporada E01 [1080p DUBLADO]", Some(1)),
            Some(1)
        );
        // Sem episódio
        assert_eq!(label_episode("The Boys [1080p WEB-DL DUBLADO]", Some(4)), None);
        // Sem episódio e declara temporada diferente -> None
        assert_eq!(
            label_episode("The Boys 3ª Temporada [1080p DUBLADO]", Some(4)),
            None
        );
        // Complete -> None
        assert_eq!(
            label_episode("The Boys Temporada Completa [1080p DUBLADO]", Some(4)),
            None
        );
    }

    #[test]
    fn test_season_page_groups_and_dn_override() {
        // NerdFilmes Euphoria: post S2, mas dn S01E00
        let euphoria = CrawlRelease {
            title: Some("Euphoria 2ª Temporada E00 [1080p DUBLADO]".into()),
            magnet: Some(
                "magnet:?xt=urn:btih:abababababababababababababababababababab&dn=Euphoria.Us.S01E00.Especial"
                    .into(),
            ),
            ..Default::default()
        };
        let page = SeasonPageInfo {
            season: Some(2),
            title: "Euphoria",
        };
        let groups = season_page_groups(&[euphoria], &page);
        assert_eq!(groups.len(), 1);
        // O dn declara S01E00, então deve ser locado em S1E0, não S2E0!
        assert_eq!(groups[0].season, Some(1));
        assert_eq!(groups[0].episode, Some(0));
    }

    #[test]
    fn test_series_row_groups_and_unlocated() {
        let s1 = CrawlRelease {
            title: Some("Pucca [TVRip DUBLADO]".into()),
            magnet: Some(
                "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=Go.Diego.Go.Temporada.1.Completo.Pt-Br"
                    .into(),
            ),
            ..Default::default()
        };
        let complete = CrawlRelease {
            title: Some("Pucca [TVRip DUBLADO]".into()),
            magnet: Some(
                "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=DESENHO+-+PUCCA+DUBLADO"
                    .into(),
            ),
            ..Default::default()
        };

        let rows = vec![
            SeriesRow {
                release: s1.clone(),
                row_season: None,
            },
            SeriesRow {
                release: complete.clone(),
                row_season: None,
            },
        ];

        let groups = series_row_groups(&rows);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].season, Some(1));
        assert_eq!(groups[0].episode, None);
        assert_eq!(groups[0].releases.len(), 1);

        let unlocated = unlocated_releases(&[s1, complete.clone()], &groups);
        assert_eq!(unlocated, vec![complete]);
    }
}
