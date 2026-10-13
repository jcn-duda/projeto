//! Bindings NAPI para o parser do raspador (`adom-crawl`).

use napi_derive::napi;

#[napi(object)]
pub struct CrawlParsedReleaseNapi {
    pub title: String,
    pub magnet: String,
    pub indexer: String,
    pub tracker: String,
    pub is_br: bool,
    pub seeders: i64,
    pub size: Option<String>,
}

#[napi(object)]
pub struct CrawlParsedGroupNapi {
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub releases: Vec<CrawlParsedReleaseNapi>,
}

#[napi(object)]
pub struct CrawlPageParsedNapi {
    pub url: String,
    pub status: String,
    pub imdb: Option<String>,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub original_title: Option<String>,
    pub season: Option<i64>,
    pub work_type: Option<String>,
    pub releases: Vec<CrawlParsedReleaseNapi>,
    pub groups: Vec<CrawlParsedGroupNapi>,
    pub unlocated: Vec<CrawlParsedReleaseNapi>,
    pub error: Option<String>,
}

#[napi]
pub fn parse_crawl_page(
    site: String,
    kind: String,
    url: String,
    html: String,
) -> CrawlPageParsedNapi {
    let parsed = adom_crawl::parse_crawl_page(&site, &kind, &url, &html);
    CrawlPageParsedNapi {
        url: parsed.url,
        status: parsed.status,
        imdb: parsed.imdb,
        title: parsed.title,
        year: parsed.year,
        original_title: parsed.original_title,
        season: parsed.season,
        work_type: parsed.work_type,
        releases: parsed
            .releases
            .into_iter()
            .map(|r| CrawlParsedReleaseNapi {
                title: r.title,
                magnet: r.magnet,
                indexer: r.indexer,
                tracker: r.tracker,
                is_br: r.is_br,
                seeders: r.seeders,
                size: r.size,
            })
            .collect(),
        groups: parsed
            .groups
            .into_iter()
            .map(|g| CrawlParsedGroupNapi {
                season: g.season,
                episode: g.episode,
                releases: g
                    .releases
                    .into_iter()
                    .map(|r| CrawlParsedReleaseNapi {
                        title: r.title,
                        magnet: r.magnet,
                        indexer: r.indexer,
                        tracker: r.tracker,
                        is_br: r.is_br,
                        seeders: r.seeders,
                        size: r.size,
                    })
                    .collect(),
            })
            .collect(),
        unlocated: parsed
            .unlocated
            .into_iter()
            .map(|r| CrawlParsedReleaseNapi {
                title: r.title,
                magnet: r.magnet,
                indexer: r.indexer,
                tracker: r.tracker,
                is_br: r.is_br,
                seeders: r.seeders,
                size: r.size,
            })
            .collect(),
        error: parsed.error,
    }
}
