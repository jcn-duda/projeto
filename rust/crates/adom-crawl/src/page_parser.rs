//! Parser central de páginas de raspagem para todos os sites BR.
//!
//! Este módulo unifica o parsing das páginas dos 9 sites do motor:
//! entra `(site, kind, url, html)` e sai `CrawlPageParsed` estruturado,
//! com status (`done`, `no-torrent`, `error`), metadados da obra (título, ano, imdb),
//! e releases agrupadas ou planas.
//!
//! O ROTEAMENTO por site é o ponto sensível: cada site tem o SEU parser de
//! links. O ramo genérico (`_`) cobre BLUDV/Comando/NerdFilmes/TDF, e cada um
//! resolve href pela régua do seu profile (ver `page_parser::sites`). O
//! ComandoTorrents usa a mesma régua de protetor da vaca (o
//! `createProtectorHrefResolver` do núcleo). As peças de montagem (filtro de
//! magnet, dedupe, grupos e o JSON do Mico) vivem em `page_parser::build`.

mod build;
mod sites;
mod types;

pub use types::{CrawlPageParsed, CrawlParsedGroup, CrawlParsedRelease};

use std::collections::HashMap;

use crate::listing::{apache_parse_imdb_id, hdr_parse_imdb_id};
use crate::profile_parsers::{
    is_valid_magnet_uri, parse_content_magnets, parse_download_links, parse_post_links,
    parse_post_magnets, ResolverLink,
};
use crate::season_page::{page_season_of, series_row_groups, unlocated_releases, SeriesRow};
use crate::sitemap::{parse_bludv_imdb_id, parse_imdb_id, parse_vaca_imdb_id};
use crate::vaca_series::{group_series_releases, GroupSeriesOptions, SeriesReleaseEntry};
use crate::work_name::read_work_title;

use build::{build_parsed_outcome, build_release_from_link, parse_mico_content};
use sites::{bludv_gate_buttons, parse_bludv_links, parse_nerdfilmes_links, parse_tdf_links};

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
    parse_crawl_page_with(site, kind, url, content, &HashMap::new())
}

/// Botões de protetor (URL sem magnet) que o resolver local sabe seguir, na
/// ordem da página. BLUDV fica de fora de propósito: o botão dele é o portão de
/// anúncio, que o índice nunca atravessa.
pub fn protector_buttons(site: &str, url: &str, content: &str) -> Vec<String> {
    let site_id = canonical_site_id(site);
    if !matches!(
        site_id,
        "comandotorrents" | "nerdfilmes" | "torrentdosfilmesv2"
    ) {
        return Vec::new();
    }
    button_links(site_id, url, content)
        .into_iter()
        .map(|l| l.url)
        .filter(|u| !is_valid_magnet_uri(u))
        .collect()
}

/// Botões do ramo genérico: cada site resolve o href pela régua do PRÓPRIO
/// profile; o Comando compartilha o resolvedor de protetor da vaca.
fn button_links(site_id: &str, url: &str, content: &str) -> Vec<ResolverLink> {
    match site_id {
        "bludv-cardigann" => parse_bludv_links(content),
        "nerdfilmes" => parse_nerdfilmes_links(content, Some(url)),
        "torrentdosfilmesv2" => parse_tdf_links(content),
        _ => parse_download_links(content, Some(url), None, None),
    }
}

/// [`parse_crawl_page`] com os magnets dos botões de protetor já seguidos
/// (`href do botão → magnet`), vindos do resolver local.
pub fn parse_crawl_page_with(
    site: &str,
    kind: &str,
    url: &str,
    content: &str,
    resolved: &HashMap<String, String>,
) -> CrawlPageParsed {
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
                    gate: None,
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
                    gate: None,
                }
            } else {
                build_parsed_outcome(
                    url, title, year, imdb, work_type, indexer, tracker, &links, false,
                )
            }
        }
        _ => {
            // Bludv, ComandoTorrents, NerdFilmes, TDF. Cada site resolve o href
            // pela régua do PRÓPRIO profile; o Comando compartilha o resolvedor
            // de protetor da vaca (`parse_download_links`).
            let mut links = button_links(site_id, url, content);
            // Botão de protetor que o resolver local já seguiu vira o magnet
            // dele; o resto da régua (áudio, qualidade, episódio) não muda.
            for link in &mut links {
                if let Some(magnet) = resolved.get(&link.url) {
                    link.url = magnet.clone();
                }
            }
            if links.is_empty() {
                // BLUDV: post que SÓ publica o portão de anúncio não é "sem
                // torrent" nem erro queimando tentativa — vira PENDÊNCIA de
                // portão (`gate-pending`): a página anuncia torrent, o magnet
                // só sai após pagar o portão (~30s de FlareSolverr), custo
                // que nunca cabe no passo de raspagem. O executor de fundo
                // paga pelo resolver local e grava a release no acervo
                // depois. "no-torrent" fica para a página que não colhe
                // magnet NEM portão (o caso do Nerd, commit f69fe0a).
                if site_id == "bludv-cardigann" {
                    if let Some(gate) = bludv_gate_buttons(content).into_iter().next() {
                        return CrawlPageParsed::gate_pending(
                            url,
                            Some(title),
                            year,
                            imdb,
                            Some(work_type.to_string()),
                            &gate,
                        );
                    }
                }
                return CrawlPageParsed::no_torrent(
                    url,
                    Some(title),
                    year,
                    imdb,
                    Some(work_type.to_string()),
                );
            }

            // Botão de protetor (URL sem magnet) prova que a página ANUNCIA
            // torrent; o sidecar o segue pelo resolver local (`resolved`). O
            // que sobra sem magnet colhido é `no-torrent`, nunca `done` vazio
            // (o TS do motor só fecha `done` com releases).
            build_parsed_outcome(
                url, title, year, imdb, work_type, indexer, tracker, &links, is_series,
            )
        }
    }
}

#[cfg(test)]
#[path = "page_parser_tests.rs"]
mod tests;
