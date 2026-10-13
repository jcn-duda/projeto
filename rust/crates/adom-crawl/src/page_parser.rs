//! Parser central de páginas de raspagem para todos os sites BR.
//!
//! Este módulo unifica o parsing das páginas dos 9 sites do motor:
//! entra `(site, kind, url, html)` e sai `CrawlPageParsed` estruturado,
//! com status (`done`, `no-torrent`, `error`), metadados da obra (título, ano, imdb),
//! e releases agrupadas ou planas.

use serde::{Deserialize, Serialize};

use crate::listing::{apache_parse_imdb_id, hdr_parse_imdb_id, parse_size};
use crate::mico::parse_mico_url;
use crate::profile_parsers::{
    extract_magnet, parse_content_magnets, parse_download_links, parse_post_links,
    parse_post_magnets, release_title, ResolverLink,
};
use crate::season_page::{
    page_season_of, season_page_groups, series_row_groups, unlocated_releases, SeasonPageInfo,
    SeriesRow,
};
use crate::shared::magnet_hash;
use crate::sitemap::{parse_bludv_imdb_id, parse_imdb_id, parse_vaca_imdb_id};
use crate::vaca_series::{
    group_series_releases, CrawlReleaseItem, GroupSeriesOptions, SeriesReleaseEntry,
};
use crate::work_name::read_work_title;

/// Release crua extraída pelo parser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlParsedRelease {
    pub title: String,
    pub magnet: String,
    pub indexer: String,
    pub tracker: String,
    pub is_br: bool,
    pub seeders: i64,
    pub size: Option<String>,
}

impl CrawlReleaseItem for CrawlParsedRelease {
    fn title(&self) -> &str {
        &self.title
    }

    fn magnet_display_name(&self) -> String {
        adom_core::magnet_display_name(Some(&self.magnet), None, None)
    }
}

/// Grupo de releases por temporada/episódio para séries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlParsedGroup {
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub releases: Vec<CrawlParsedRelease>,
}

/// Resultado estruturado do parsing de uma página de obra.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlPageParsed {
    pub url: String,
    pub status: String, // "done" | "no-torrent" | "error"
    pub imdb: Option<String>,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub original_title: Option<String>,
    pub season: Option<i64>,
    pub work_type: Option<String>, // "movie" | "series"
    pub releases: Vec<CrawlParsedRelease>,
    pub groups: Vec<CrawlParsedGroup>,
    pub unlocated: Vec<CrawlParsedRelease>,
    pub error: Option<String>,
}

impl CrawlPageParsed {
    pub fn error(url: &str, msg: &str) -> Self {
        Self {
            url: url.to_string(),
            status: "error".to_string(),
            imdb: None,
            title: None,
            year: None,
            original_title: None,
            season: None,
            work_type: None,
            releases: Vec::new(),
            groups: Vec::new(),
            unlocated: Vec::new(),
            error: Some(msg.to_string()),
        }
    }

    pub fn no_torrent(
        url: &str,
        title: Option<String>,
        year: Option<i64>,
        imdb: Option<String>,
        work_type: Option<String>,
    ) -> Self {
        Self {
            url: url.to_string(),
            status: "no-torrent".to_string(),
            imdb,
            title,
            year,
            original_title: None,
            season: None,
            work_type,
            releases: Vec::new(),
            groups: Vec::new(),
            unlocated: Vec::new(),
            error: None,
        }
    }
}

/// Normaliza o identificador do site para a chave padrão.
pub fn canonical_site_id(site: &str) -> &'static str {
    match site.trim().to_lowercase().as_str() {
        "bludv" | "bludv-cardigann" => "bludv-cardigann",
        "comandotorrents" => "comandotorrents",
        "nerdfilmes" => "nerdfilmes",
        "vaca" | "vacatorrent" => "vacatorrent",
        "redetorrent" | "redetorrent-cardigann" => "redetorrent-cardigann",
        "hdr" | "hdrtorrents" | "hdrtorrent-cardigann" => "hdrtorrent-cardigann",
        "apache" | "apachetorrent" | "apachetorrent-cardigann" => "apachetorrent-cardigann",
        "torrentdosfilmes" | "torrentdosfilmesv2" => "torrentdosfilmesv2",
        "mico" => "mico",
        _ => "unknown",
    }
}

/// Parser unificado de página para todos os sites suportados.
pub fn parse_crawl_page(site: &str, kind: &str, url: &str, content: &str) -> CrawlPageParsed {
    let site_id = canonical_site_id(site);
    let is_series = kind == "tv_show" || kind == "series";
    let work_type = if is_series { "series" } else { "movie" };

    if site_id == "unknown" {
        return CrawlPageParsed::error(url, &format!("site não suportado: {site}"));
    }

    // Mico é JSON
    if site_id == "mico" {
        return parse_mico_content(url, is_series, content);
    }

    // Leitura comum de metadados da página via H1 e ficha técnica
    let work_title = read_work_title(content);
    if work_title.title.trim().is_empty() {
        return CrawlPageParsed::error(url, "layout: página sem <h1> de título");
    }

    let title = work_title.title;
    let year = work_title.year.map(|y| y as i64);

    // Extração de IMDb específico por site
    let imdb = match site_id {
        "bludv-cardigann" => parse_bludv_imdb_id(content),
        "vacatorrent" => parse_vaca_imdb_id(content),
        "hdrtorrent-cardigann" => hdr_parse_imdb_id(content),
        "apachetorrent-cardigann" => apache_parse_imdb_id(content),
        _ => parse_imdb_id(content),
    };

    let (indexer, tracker) = match site_id {
        "bludv-cardigann" => ("bludv-cardigann", "BLUDV"),
        "comandotorrents" => ("comandotorrents", "Comando"),
        "nerdfilmes" => ("nerdfilmes", "NerdFilmes"),
        "vacatorrent" => ("vacatorrent", "Vaca"),
        "redetorrent-cardigann" => ("redetorrent-cardigann", "RedeTorrent"),
        "hdrtorrent-cardigann" => ("hdrtorrent-cardigann", "HDR"),
        "apachetorrent-cardigann" => ("apachetorrent-cardigann", "Apache"),
        "torrentdosfilmesv2" => ("torrentdosfilmesv2", "TorrentDosFilmes"),
        _ => (site_id, site_id),
    };

    // Extração de links e montagem de releases
    match site_id {
        "apachetorrent-cardigann" => {
            let links = parse_post_magnets(content, Some(url));
            if links.is_empty() {
                return CrawlPageParsed::no_torrent(
                    url,
                    Some(title),
                    year,
                    imdb,
                    Some(work_type.to_string()),
                );
            }
            build_parsed_outcome(
                url, title, year, imdb, work_type, indexer, tracker, &links, is_series,
            )
        }
        "hdrtorrent-cardigann" => {
            let links = parse_content_magnets(content, Some(url));
            if links.is_empty() {
                return CrawlPageParsed::no_torrent(
                    url,
                    Some(title),
                    year,
                    imdb,
                    Some(work_type.to_string()),
                );
            }
            build_parsed_outcome(
                url, title, year, imdb, work_type, indexer, tracker, &links, is_series,
            )
        }
        "redetorrent-cardigann" => {
            let links = parse_post_links(content, Some(url));
            if links.is_empty() {
                return CrawlPageParsed::no_torrent(
                    url,
                    Some(title),
                    year,
                    imdb,
                    Some(work_type.to_string()),
                );
            }

            if is_series {
                // RedeTorrent agrega temporadas por linhas
                let rows: Vec<SeriesRow<CrawlParsedRelease>> = links
                    .iter()
                    .map(|l| SeriesRow {
                        release: build_release_from_link(&title, year, indexer, tracker, l),
                        row_season: l.season.map(|s| s as i64),
                    })
                    .collect();

                let all_releases: Vec<CrawlParsedRelease> =
                    rows.iter().map(|r| r.release.clone()).collect();
                let groups_res = series_row_groups(&rows);
                let unlocated = unlocated_releases(&all_releases, &groups_res);

                let parsed_groups = groups_res
                    .into_iter()
                    .map(|g| CrawlParsedGroup {
                        season: g.season,
                        episode: g.episode,
                        releases: g.releases,
                    })
                    .collect();

                CrawlPageParsed {
                    url: url.to_string(),
                    status: "done".to_string(),
                    imdb,
                    title: Some(title),
                    year,
                    original_title: None,
                    season: None,
                    work_type: Some(work_type.to_string()),
                    releases: Vec::new(),
                    groups: parsed_groups,
                    unlocated,
                    error: None,
                }
            } else {
                build_parsed_outcome(
                    url, title, year, imdb, work_type, indexer, tracker, &links, false,
                )
            }
        }
        "vacatorrent" => {
            let links = parse_download_links(content, Some(url), None, None);
            if links.is_empty() {
                return CrawlPageParsed::no_torrent(
                    url,
                    Some(title),
                    year,
                    imdb,
                    Some(work_type.to_string()),
                );
            }

            if is_series {
                let season_decl = page_season_of(&title, url);
                let entries: Vec<SeriesReleaseEntry<CrawlParsedRelease>> = links
                    .iter()
                    .map(|l| {
                        let rel = build_release_from_link(&title, year, indexer, tracker, l);
                        SeriesReleaseEntry {
                            release: rel,
                            request: crate::vaca_series::SeriesLocation {
                                season: l.season.map(|s| s as i64).or(season_decl),
                                episode: l.episode.map(|e| e as i64),
                            },
                        }
                    })
                    .collect();

                let year_str = year.map(|y| y.to_string());
                let grp_out = group_series_releases(
                    &entries,
                    &GroupSeriesOptions {
                        year: year_str.as_deref(),
                        by_declared_location: true,
                    },
                );

                let parsed_groups = grp_out
                    .into_iter()
                    .map(|g| CrawlParsedGroup {
                        season: g.season,
                        episode: g.episode,
                        releases: g.releases,
                    })
                    .collect();

                CrawlPageParsed {
                    url: url.to_string(),
                    status: "done".to_string(),
                    imdb,
                    title: Some(title),
                    year,
                    original_title: None,
                    season: season_decl,
                    work_type: Some(work_type.to_string()),
                    releases: Vec::new(),
                    groups: parsed_groups,
                    unlocated: Vec::new(),
                    error: None,
                }
            } else {
                build_parsed_outcome(
                    url, title, year, imdb, work_type, indexer, tracker, &links, false,
                )
            }
        }
        _ => {
            // Bludv, Comando, NerdFilmes, TDF
            let links = parse_download_links(content, Some(url), None, None);
            if links.is_empty() {
                return CrawlPageParsed::no_torrent(
                    url,
                    Some(title),
                    year,
                    imdb,
                    Some(work_type.to_string()),
                );
            }

            build_parsed_outcome(
                url, title, year, imdb, work_type, indexer, tracker, &links, is_series,
            )
        }
    }
}

fn build_release_from_link(
    title: &str,
    year: Option<i64>,
    indexer: &str,
    tracker: &str,
    link: &ResolverLink,
) -> CrawlParsedRelease {
    let rel_title = release_title(title, year.map(|y| y as u32), link, None);
    let magnet = extract_magnet(&link.url).unwrap_or_else(|| link.url.clone());
    let size_str = link.size.as_ref().map(|s| {
        parse_size(s)
            .map(|_| s.clone())
            .unwrap_or_else(|| s.clone())
    });

    CrawlParsedRelease {
        title: rel_title,
        magnet,
        indexer: indexer.to_string(),
        tracker: tracker.to_string(),
        is_br: true,
        seeders: 1,
        size: size_str,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_parsed_outcome(
    url: &str,
    title: String,
    year: Option<i64>,
    imdb: Option<String>,
    work_type: &str,
    indexer: &str,
    tracker: &str,
    links: &[ResolverLink],
    is_series: bool,
) -> CrawlPageParsed {
    let mut releases = Vec::new();
    let mut seen_hashes = std::collections::HashSet::new();

    for link in links {
        let Some(magnet) = extract_magnet(&link.url).or_else(|| {
            if link.url.starts_with("magnet:?") {
                Some(link.url.clone())
            } else {
                None
            }
        }) else {
            continue;
        };

        if let Some(h) = magnet_hash(&magnet) {
            if !seen_hashes.insert(h) {
                continue;
            }
        }

        releases.push(build_release_from_link(
            &title,
            year,
            indexer,
            tracker,
            &ResolverLink {
                url: magnet,
                quality: link.quality,
                size: link.size.clone(),
                audio: link.audio.clone(),
                episode: link.episode,
                episode_last: link.episode_last,
                season: link.season,
                source: link.source.clone(),
                real_title: link.real_title.clone(),
                description: link.description.clone(),
            },
        ));
    }

    if releases.is_empty() {
        return CrawlPageParsed::no_torrent(
            url,
            Some(title),
            year,
            imdb,
            Some(work_type.to_string()),
        );
    }

    if is_series {
        let season_decl = page_season_of(&title, url);
        let groups = season_page_groups(
            &releases,
            &SeasonPageInfo {
                season: season_decl,
                title: &title,
            },
        );

        let parsed_groups = groups
            .into_iter()
            .map(|g| CrawlParsedGroup {
                season: g.season,
                episode: g.episode,
                releases: g.releases,
            })
            .collect();

        CrawlPageParsed {
            url: url.to_string(),
            status: "done".to_string(),
            imdb,
            title: Some(title),
            year,
            original_title: None,
            season: season_decl,
            work_type: Some(work_type.to_string()),
            releases: Vec::new(),
            groups: parsed_groups,
            unlocated: Vec::new(),
            error: None,
        }
    } else {
        CrawlPageParsed {
            url: url.to_string(),
            status: "done".to_string(),
            imdb,
            title: Some(title),
            year,
            original_title: None,
            season: None,
            work_type: Some(work_type.to_string()),
            releases,
            groups: Vec::new(),
            unlocated: Vec::new(),
            error: None,
        }
    }
}

fn parse_mico_content(url: &str, is_series: bool, json_text: &str) -> CrawlPageParsed {
    let parsed_url = parse_mico_url(url, None);
    let imdb = parsed_url.as_ref().map(|p| p.imdb.clone());

    let v: serde_json::Value = match serde_json::from_str(json_text) {
        Ok(val) => val,
        Err(e) => return CrawlPageParsed::error(url, &format!("mico json inválido: {e}")),
    };

    // Pode ser resposta de streams: { "streams": [...] }
    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        let mut releases = Vec::new();
        for item in streams {
            let title = item
                .get("title")
                .and_then(|t| t.as_str())
                .or_else(|| item.get("name").and_then(|n| n.as_str()))
                .unwrap_or("Mico Release")
                .to_string();

            let magnet = if let Some(mag) = item.get("url").and_then(|u| u.as_str()) {
                if mag.starts_with("magnet:?") {
                    mag.to_string()
                } else {
                    continue;
                }
            } else if let Some(hash) = item.get("infoHash").and_then(|h| h.as_str()) {
                format!("magnet:?xt=urn:btih:{hash}")
            } else {
                continue;
            };

            releases.push(CrawlParsedRelease {
                title,
                magnet,
                indexer: "mico".to_string(),
                tracker: "Mico".to_string(),
                is_br: true,
                seeders: 1,
                size: None,
            });
        }

        return CrawlPageParsed {
            url: url.to_string(),
            status: if releases.is_empty() {
                "no-torrent".to_string()
            } else {
                "done".to_string()
            },
            imdb,
            title: None,
            year: None,
            original_title: None,
            season: None,
            work_type: Some(if is_series { "series" } else { "movie" }.to_string()),
            releases,
            groups: Vec::new(),
            unlocated: Vec::new(),
            error: None,
        };
    }

    CrawlPageParsed::no_torrent(
        url,
        None,
        None,
        imdb,
        Some(if is_series { "series" } else { "movie" }.to_string()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_canonical_site_id() {
        assert_eq!(canonical_site_id("bludv"), "bludv-cardigann");
        assert_eq!(canonical_site_id("VacaTorrent"), "vacatorrent");
        assert_eq!(
            canonical_site_id("redetorrent-cardigann"),
            "redetorrent-cardigann"
        );
        assert_eq!(canonical_site_id("mico"), "mico");
        assert_eq!(canonical_site_id("desconhecido"), "unknown");
    }

    #[test]
    fn test_parse_crawl_page_bludv_mock() {
        let html = r#"
            <h1>Matrix (1999)</h1>
            <b>IMDb:</b> <a href="https://www.imdb.com/title/tt0133093/">7.8</a>
            <div class="download-links">
                <a href="magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=Matrix.1999.1080p.DUAL">Download 1080p (2.5 GB)</a>
            </div>
        "#;
        let res = parse_crawl_page(
            "bludv",
            "movie",
            "https://bludv.com/filmes/matrix-1999-download/",
            html,
        );
        assert_eq!(res.status, "done");
        assert_eq!(res.title, Some("Matrix".to_string()));
        assert_eq!(res.year, Some(1999));
        assert_eq!(res.imdb, Some("tt0133093".to_string()));
        assert_eq!(res.releases.len(), 1);
        assert_eq!(res.releases[0].tracker, "BLUDV");
    }
}
