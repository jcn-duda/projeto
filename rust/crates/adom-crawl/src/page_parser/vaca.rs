//! Desfecho da página do Vaca a partir dos botões já conhecidos. Serve às duas
//! entradas: o parser de uma página só e o motor, que segue o post até os botões
//! (`page_engine_vaca`), e por isso não pode morar dentro do `match` por site.

use crate::profile_parsers::ResolverLink;
use crate::season_page::page_season_of;
use crate::vaca_series::{group_series_releases, GroupSeriesOptions, SeriesReleaseEntry};

use super::build::{build_parsed_outcome, build_release_from_link};
use super::types::{CrawlPageParsed, CrawlParsedGroup, CrawlParsedRelease};

const INDEXER: &str = "vacatorrent";
const TRACKER: &str = "Vaca";

pub(super) fn vaca_outcome(
    url: &str,
    title: String,
    year: Option<i64>,
    imdb: Option<String>,
    is_series: bool,
    links: &[ResolverLink],
) -> CrawlPageParsed {
    let work_type = if is_series { "series" } else { "movie" };
    if links.is_empty() {
        return CrawlPageParsed::no_torrent(
            url,
            Some(title),
            year,
            imdb,
            Some(work_type.to_string()),
        );
    }
    if !is_series {
        return build_parsed_outcome(
            url, title, year, imdb, work_type, INDEXER, TRACKER, links, false,
        );
    }
    let season_decl = page_season_of(&title, url);
    let entries: Vec<SeriesReleaseEntry<CrawlParsedRelease>> = links
        .iter()
        .map(|l| SeriesReleaseEntry {
            release: build_release_from_link(&title, year, INDEXER, TRACKER, l),
            request: crate::vaca_series::SeriesLocation {
                season: l.season.map(|s| s as i64).or(season_decl),
                episode: l.episode.map(|e| e as i64),
            },
        })
        .collect();
    let year_str = year.map(|y| y.to_string());
    let groups = group_series_releases(
        &entries,
        &GroupSeriesOptions {
            year: year_str.as_deref(),
            by_declared_location: true,
        },
    )
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
        groups,
        unlocated: Vec::new(),
        error: None,
        gate: None,
    }
}
