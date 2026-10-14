//! Golden `crawl-parsers` — parsers puros do raspador (fases C0/C1).
//!
//! Consome `rust/golden/crawl-parsers.jsonl` (expected SEMPRE medido do `dist`
//! vivo pelo oráculo `scripts/golden/crawl-parsers-oracle.mjs`) e reproduz cada
//! `op` pela API pública de `adom-crawl` (`work_name`, `shared`, `season_page`,
//! `mico`, `sitemap`, `listing`, `profile_parsers`). As fixtures ficam em
//! `test/fixtures/` (mesmo caminho do oráculo), lidas do disco.
mod golden_common;

use adom_crawl::listing;
use adom_crawl::mico;
use adom_crawl::parse_crawl_page;
use adom_crawl::profile_parsers::{self, ResolverLink};
use adom_crawl::season_page::{self, SeasonPageInfo, SeriesRow};
use adom_crawl::shared;
use adom_crawl::sitemap::{self, SitemapEntry};
use adom_crawl::vaca_series::{
    self, CrawlRelease, CrawlReleaseGroup, GroupSeriesOptions, LinkEvidence, SeriesLocation,
    SeriesReleaseEntry,
};
use adom_crawl::work_name;
use golden_common::*;
use serde_json::{json, Value};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/crawl-parsers.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/crawl-parsers.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-crawl-parsers.json");
const REGISTRY: &str = "crawl-parsers/crawlParsers";
const FORMAT: &str = "adom-golden-manifest/1";
const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../test/fixtures");

fn fx(rel: &str) -> String {
    std::fs::read_to_string(format!("{FIX}/{rel}")).unwrap_or_else(|e| panic!("fixture {rel}: {e}"))
}

fn canon_links(links: &[ResolverLink]) -> String {
    let arr: Vec<Value> = links
        .iter()
        .map(|l| {
            json!({
                "url": l.url, "quality": l.quality, "size": l.size, "audio": l.audio,
                "source": l.source, "episode": l.episode, "season": l.season,
            })
        })
        .collect();
    canon(&json!(arr))
}

fn canon_entries(list: &[SitemapEntry]) -> String {
    canon(&json!(list
        .iter()
        .map(|e| json!({ "loc": e.loc, "lastmod": e.lastmod }))
        .collect::<Vec<_>>()))
}

fn imdb_of(site: &str, html: &str) -> Option<String> {
    match site {
        "vaca" => sitemap::parse_vaca_imdb_id(html),
        "bludv" => sitemap::parse_bludv_imdb_id(html),
        "hdr" => listing::hdr_parse_imdb_id(html),
        "apache" => listing::apache_parse_imdb_id(html),
        _ => sitemap::parse_imdb_id(html),
    }
}

fn render(r: &Value) -> String {
    let op = r["op"].as_str().expect("campo op");
    let f = |key: &str| fx(r[key].as_str().expect("campo fixture"));
    match op {
        "readWorkTitle" => {
            let w = work_name::read_work_title(&f("fixture"));
            canon(&json!({ "title": w.title, "year": w.year }))
        }
        "h1Text" => work_name::h1_text(&f("fixture")),
        "splitParenYear" => {
            let s = work_name::split_paren_year(r["raw"].as_str().unwrap());
            canon(&json!({ "rest": s.rest, "year": s.year }))
        }
        "cleanWorkName" => work_name::clean_work_name(r["text"].as_str().unwrap()),
        "fichaYear" => match work_name::ficha_year(&f("fixture")) {
            Some(y) => y.to_string(),
            None => "null".to_string(),
        },
        "parseTitleYear" => {
            let t = shared::parse_title_year(&f("fixture"));
            canon(&json!({ "title": t.title, "year": t.year }))
        }
        "parseOriginalTitle" => {
            shared::parse_original_title(&f("fixture")).unwrap_or_else(|| "null".to_string())
        }
        "magnetHash" => {
            shared::magnet_hash(r["magnet"].as_str().unwrap()).unwrap_or_else(|| "null".to_string())
        }
        "isImdbWidgetReference" => bit(shared::is_imdb_widget_reference(
            r["suffix"].as_str().unwrap(),
        )),
        "pageSeasonOf" => opt_i64(season_page::page_season_of(
            r["h1"].as_str().unwrap(),
            r["url"].as_str().unwrap(),
        )),
        "strideAt" => num_str(mico::stride_at(r["skip"].as_u64().unwrap() as u32) as i64),
        "bucketLastmod" => mico::bucket_lastmod(
            r["tt"].as_str().unwrap(),
            r["now"].as_i64().unwrap(),
            r["periodDays"].as_u64().unwrap() as u32,
        ),
        "parseMicoUrl" => match mico::parse_mico_url(r["url"].as_str().unwrap(), None) {
            Some(p) => {
                canon(&json!({ "imdb": p.imdb, "kind": serde_json::to_value(p.kind).unwrap() }))
            }
            None => "null".to_string(),
        },
        "syntheticUrl" => {
            let kind = if r["kind"].as_str().unwrap() == "series" {
                mico::MicoKind::Series
            } else {
                mico::MicoKind::Movie
            };
            mico::synthetic_url(kind, r["tt"].as_str().unwrap(), None)
        }
        "isXmlSitemapShape" => bit(sitemap::is_xml_sitemap_shape(&f("fixture"))),
        "isVacaSitemapShape" => bit(sitemap::is_vaca_sitemap_shape(&f("fixture"))),
        "parseSitemapEntries" => canon_entries(&sitemap::parse_sitemap_entries(&f("fixture"))),
        "parseSitemapRows" => canon_entries(&sitemap::parse_sitemap_rows(&f("fixture"))),
        "parseImdbId" => imdb_of(r["site"].as_str().unwrap(), &f("fixture"))
            .unwrap_or_else(|| "null".to_string()),
        "apacheParseListingCards" => {
            let cards =
                listing::apache_parse_listing_cards(&f("fixture"), r["baseUrl"].as_str().unwrap());
            canon(&json!(cards
                .iter()
                .map(|c| json!({ "kind": serde_json::to_value(c.kind).unwrap(), "url": c.url }))
                .collect::<Vec<_>>()))
        }
        "hdrCountListingCards" => num_str(listing::hdr_count_listing_cards(&f("fixture")) as i64),
        "parseSize" => match listing::parse_size(r["text"].as_str().unwrap()) {
            Some(n) => n.to_string(),
            None => "null".to_string(),
        },
        "parsePostMagnets" => canon_links(&profile_parsers::parse_post_magnets(
            &f("fixture"),
            Some(r["url"].as_str().unwrap()),
        )),
        "parseContentMagnets" => canon_links(&profile_parsers::parse_content_magnets(
            &f("fixture"),
            Some(r["url"].as_str().unwrap()),
        )),
        "parsePostLinks" => canon_links(&profile_parsers::parse_post_links(
            &f("fixture"),
            Some(r["url"].as_str().unwrap()),
        )),
        "parseDownloadLinks" => canon_links(&profile_parsers::parse_download_links(
            &f("fixture"),
            Some(r["url"].as_str().unwrap()),
            None,
            None,
        )),
        // --- unidade de SÉRIE do Vaca (season page + cards concatenados) -----
        "parseSeasonInternal" => {
            let cards = profile_parsers::parse_season_internal(
                &f("fixture"),
                Some(r["baseUrl"].as_str().unwrap()),
            );
            canon(&json!(cards
                .iter()
                .map(|c| json!({ "isBatch": c.is_batch, "season": c.season, "title": c.title, "url": c.url }))
                .collect::<Vec<_>>()))
        }
        "seasonFromCardSlug" => opt_i64(vaca_series::season_from_card_slug(
            r["url"].as_str().unwrap(),
        )),
        "declaredSeriesLocation" => {
            let e = LinkEvidence {
                card_season: r["cardSeason"].as_i64(),
                card_title: r["cardTitle"].as_str().unwrap_or("").to_string(),
                is_batch: r["isBatch"].as_bool().unwrap_or(false),
                real_title: r["realTitle"].as_str().map(|s| s.to_string()),
                dn: r["dn"].as_str().map(|s| s.to_string()),
                link_episode: r["linkEpisode"].as_i64(),
            };
            let l = vaca_series::declared_series_location(&e);
            canon(&json!({ "episode": l.episode, "season": l.season }))
        }
        "groupSeriesReleases" => {
            let entries: Vec<SeriesReleaseEntry<CrawlRelease>> = r["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| SeriesReleaseEntry {
                    release: serde_json::from_value(e["release"].clone()).unwrap(),
                    request: SeriesLocation {
                        season: e["request"]["season"].as_i64(),
                        episode: e["request"]["episode"].as_i64(),
                    },
                })
                .collect();
            let opts = GroupSeriesOptions {
                year: r["year"].as_str(),
                by_declared_location: r["byDeclaredLocation"].as_bool().unwrap_or(false),
            };
            let groups = vaca_series::group_series_releases::<CrawlRelease>(&entries, &opts);
            canon(&json!(groups
                .iter()
                .map(|g| json!({ "episode": g.episode, "n": g.releases.len(), "season": g.season }))
                .collect::<Vec<_>>()))
        }
        "decodeEvidence" => vaca_series::decode_evidence(r["text"].as_str().unwrap()),
        "repairMangledEntities" => {
            profile_parsers::repair_mangled_entities(r["text"].as_str().unwrap())
        }
        // --- agrupamento por locação (season page / página agregadora) --------
        "seasonPageGroups" => {
            let releases = crawl_releases(&r["releases"]);
            let page = SeasonPageInfo {
                season: r["page"]["season"].as_i64(),
                title: r["page"]["title"].as_str().unwrap_or(""),
            };
            canon(&canon_groups(&season_page::season_page_groups::<
                CrawlRelease,
            >(&releases, &page)))
        }
        "seriesRowGroups" => {
            let rows: Vec<SeriesRow<CrawlRelease>> = r["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| SeriesRow {
                    release: serde_json::from_value(x["release"].clone()).unwrap(),
                    row_season: x["rowSeason"].as_i64(),
                })
                .collect();
            canon(&canon_groups(
                &season_page::series_row_groups::<CrawlRelease>(&rows),
            ))
        }
        "unlocatedReleases" => {
            let releases = crawl_releases(&r["releases"]);
            let groups: Vec<CrawlReleaseGroup<CrawlRelease>> = r["groups"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| CrawlReleaseGroup {
                    season: g["season"].as_i64(),
                    episode: g["episode"].as_i64(),
                    releases: crawl_releases(&g["releases"]),
                })
                .collect();
            let rest = season_page::unlocated_releases::<CrawlRelease>(&releases, &groups);
            canon(&json!(rest
                .iter()
                .map(|x| x.title.clone().unwrap_or_default())
                .collect::<Vec<_>>()))
        }
        // --- Mico: parser de streams (parse_crawl_page do `mico`) -------------
        "parseMicoPage" => {
            let url = r["url"].as_str().unwrap_or("https://mico/");
            let kind = r["kind"].as_str().unwrap_or("movie");
            let content = serde_json::to_string(&r["streams"]).unwrap();
            let parsed = parse_crawl_page("mico", kind, url, &content);
            let releases: Vec<Value> = parsed
                .releases
                .iter()
                .map(|x| json!({ "hash": btih(&x.magnet), "title": x.title }))
                .collect();
            canon(&json!({ "imdb": parsed.imdb, "status": parsed.status, "releases": releases }))
        }
        other => panic!("op desconhecida no golden: {other}"),
    }
}

fn opt_i64(v: Option<i64>) -> String {
    match v {
        Some(n) => num_str(n),
        None => "null".to_string(),
    }
}

fn crawl_releases(v: &Value) -> Vec<CrawlRelease> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| serde_json::from_value(x.clone()).unwrap())
        .collect()
}

/// btih (40 hex, minúsculo) de um magnet do Rust.
fn btih(magnet: &str) -> String {
    let lower = magnet.to_lowercase();
    let Some(i) = lower.find("btih:") else {
        return String::new();
    };
    lower[i + 5..]
        .chars()
        .take_while(|c| c.is_ascii_hexdigit())
        .take(40)
        .collect()
}

fn canon_groups(groups: &[CrawlReleaseGroup<CrawlRelease>]) -> Value {
    json!(groups
        .iter()
        .map(|g| json!({ "episode": g.episode, "n": g.releases.len(), "season": g.season }))
        .collect::<Vec<_>>())
}

#[test]
fn manifest_identidade_e_contagem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, FORMAT);
    assert_eq!(m.registry, vec![REGISTRY.to_string()]);
    assert_eq!(m.output.lines, jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/crawl-parsers.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-crawl-parsers.json");
}

#[test]
fn ids_unicos_e_corpus_concorda() {
    let cases = parse_cases(JSONL_BYTES);
    let mut ids = std::collections::HashSet::new();
    for c in &cases {
        assert!(ids.insert(c.id.as_str()), "id duplicado: {}", c.id);
    }
    assert_corpus_matches(CORPUS_TEXT, &cases);
}

#[test]
fn saidas_batem_com_o_golden() {
    let cases = parse_cases(JSONL_BYTES);
    assert_eq!(cases.len(), 138, "contagem de casos do corpus mudou");
    let mut diffs: Vec<String> = Vec::new();
    for case in &cases {
        let input: Value = serde_json::from_str(&case.input).expect("input JSON");
        let op = input["op"].as_str().unwrap_or("?");
        // `catch_unwind`: um pânico do Rust (ex.: `c[1]` num grupo que não
        // participou) entra como DIVERGÊNCIA do caso, sem derrubar a lista toda.
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render(&input))) {
            Ok(got) if got == case.expected => {}
            Ok(got) => diffs.push(format!(
                "[{0}] op={op}\n  ts={1}\n  rs={got}",
                case.id, case.expected
            )),
            Err(_) => diffs.push(format!(
                "[{}] op={op} PÂNICO do Rust (esperado={})",
                case.id, case.expected
            )),
        }
    }
    assert!(
        diffs.is_empty(),
        "{} divergência(s) TS×Rust:\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}
