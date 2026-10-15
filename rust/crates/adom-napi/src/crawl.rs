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

#[napi(catch_unwind)]
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

#[cfg(test)]
mod tests {
    use super::*;

    /// O `#[napi(catch_unwind)]` é a rede no limite Node; ela só faz sentido se o
    /// parser do núcleo não entrar em pânico. Varre entradas hostis (site vazio,
    /// HTML truncado/desbalanceado, JSON inválido) e exige um status válido, sem
    /// `panic`/indexação fora de faixa.
    #[test]
    fn parse_crawl_page_resiste_a_entrada_hostil() {
        let enorme = "🌐".repeat(2000);
        let hostis = [
            ("", "movie", "", ""),
            ("desconhecido", "movie", "https://x/", "<html>"),
            (
                "mico",
                "series",
                "https://mico/",
                "{\"streams\":[{\"title\":\"x\"}]}",
            ),
            ("mico", "movie", "https://mico/", "não é json"),
            ("bludv", "movie", "https://bludv/f", "<h1>Filme (2024)</h1>"),
            (
                "hdrtorrents",
                "tv_show",
                "https://hdr/",
                "<main itemscope itemtype=\"https://schema.org/TVSeries\"><h1>Serie</h1></main>",
            ),
            (
                "vacatorrent",
                "series",
                "https://vaca/",
                "<h1>Serie</h1><a href=\"magnet:?xt=urn:btih:\">x</a>",
            ),
            (
                "redetorrent",
                "movie",
                "https://rede/",
                "<h1>Filme</h1><table><tr><td>",
            ),
            (
                "apachetorrent",
                "movie",
                "https://apache/",
                "<h1>Filme</h1>",
            ),
            ("nerdfilmes", "movie", "https://nerd/", "\u{0}\u{0}\u{0}"),
            (
                "comandotorrents",
                "movie",
                "https://comando/",
                "<h1>   </h1>",
            ),
            ("torrentdosfilmes", "movie", "https://tdf/", enorme.as_str()),
        ];
        for (site, kind, url, html) in hostis {
            let parsed = parse_crawl_page(
                site.to_string(),
                kind.to_string(),
                url.to_string(),
                html.to_string(),
            );
            assert!(
                matches!(parsed.status.as_str(), "done" | "no-torrent" | "error"),
                "status inesperado para site={site}: {}",
                parsed.status
            );
        }
    }
}
