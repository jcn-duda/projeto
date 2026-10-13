//! Testes de integração de adom-crawl contra as fixtures reais do repositório.

use adom_crawl::listing::*;
use adom_crawl::mico::*;
use adom_crawl::profile_parsers::*;
use adom_crawl::sitemap::*;
use adom_crawl::work_name::*;

const FIXTURES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../test/fixtures");

fn load_fixture(rel_path: &str) -> String {
    let path = format!("{FIXTURES_DIR}/{rel_path}");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("falha ao carregar fixture em {path}: {e}"))
}

#[test]
fn test_fixture_bludv_sitemap_index_and_post() {
    let index_xml = load_fixture("crawl/bludv/sitemap-index.xml");
    assert!(is_xml_sitemap_shape(&index_xml));
    let sitemaps = parse_sitemap_entries(&index_xml);
    assert!(!sitemaps.is_empty());
    assert!(sitemaps.iter().any(|s| s.loc.contains("post-sitemap")));

    let post_html = load_fixture("crawl/bludv/post-movie.html");
    let imdb = parse_bludv_imdb_id(&post_html);
    assert!(imdb.is_some());
    let imdb_str = imdb.unwrap();
    assert!(imdb_str.starts_with("tt"));

    let work_title = read_work_title(&post_html);
    assert!(!work_title.title.is_empty());
}

#[test]
fn test_fixture_vaca_pages_imdb_and_work_name() {
    let movie_html = load_fixture("crawl/vaca/movie-page-torrent.html");
    let imdb = parse_vaca_imdb_id(&movie_html);
    assert!(imdb.is_some());
    assert_eq!(imdb.unwrap(), "tt1706620");

    let work_title = read_work_title(&movie_html);
    assert_eq!(work_title.title, "Expresso do Amanhã");
    assert_eq!(work_title.year, Some(2013));
}

#[test]
fn test_fixture_vaca_movie_sitemap_xml() {
    let sitemap_xml = load_fixture("crawl/vaca/movie-sitemap11.xml");
    assert!(is_xml_sitemap_shape(&sitemap_xml));
    let entries = parse_sitemap_entries(&sitemap_xml);
    assert!(!entries.is_empty());
    for e in entries.iter().take(5) {
        assert!(e.loc.starts_with("http"));
        assert!(!e.lastmod.is_empty());
        assert!(e.lastmod.contains('T'));
    }
}

#[test]
fn test_fixture_apache_listing_and_post() {
    let listing_html = load_fixture("crawl/apachetorrent/pagina-1-cheia.html");
    let cards = apache_parse_listing_cards(&listing_html, "https://apachetorrent.com");
    assert!(!cards.is_empty());

    let post_html = load_fixture("crawl/apachetorrent/post-filme.html");
    let imdb = apache_parse_imdb_id(&post_html);
    assert!(imdb.is_some());

    let magnets = parse_post_magnets(&post_html, Some("https://apachetorrent.com"));
    assert!(!magnets.is_empty());
    assert!(magnets[0].url.starts_with("magnet:?"));
}

#[test]
fn test_fixture_hdr_listing_and_post() {
    let listing_html = load_fixture("crawl/hdrtorrents/pagina-1-cheia.html");
    let cards = hdr_parse_listing_cards(&listing_html, "https://hdrtorrents.org");
    assert!(!cards.is_empty());

    let post_html = load_fixture("crawl/hdrtorrents/post-filme.html");
    let imdb = hdr_parse_imdb_id(&post_html);
    assert!(imdb.is_some());

    let magnets = parse_content_magnets(&post_html, Some("https://hdrtorrents.org"));
    assert!(!magnets.is_empty());
    assert!(magnets[0].url.starts_with("magnet:?"));
}

#[test]
fn test_fixture_comandotorrents_sitemaps() {
    let sitemap_xml = load_fixture("crawl/comandotorrents/post-sitemap.xml");
    assert!(is_xml_sitemap_shape(&sitemap_xml));
    let entries = parse_sitemap_entries(&sitemap_xml);
    assert!(!entries.is_empty());
}

#[test]
fn test_fixture_nerdfilmes_sitemaps() {
    let sitemap_xml = load_fixture("crawl/nerdfilmes/post-sitemap.xml");
    assert!(is_xml_sitemap_shape(&sitemap_xml));
    let entries = parse_sitemap_entries(&sitemap_xml);
    assert!(!entries.is_empty());
}

#[test]
fn test_fixture_redetorrent_post_and_viewer() {
    let post_html = load_fixture("redetorrent/post-coringa-delirio.html");
    let work_title = read_work_title(&post_html);
    assert_eq!(work_title.title, "Coringa: Delírio a Dois");
    assert_eq!(work_title.year, Some(2024));

    let links = parse_post_links(&post_html, Some("https://redetorrent.xyz"));
    assert!(!links.is_empty());
    assert!(links[0].url.starts_with("magnet:?"));
}

#[test]
fn test_fixture_mico_json_catalog() {
    let json_text = load_fixture("crawl/mico/catalog-skip-0.json");
    let v: serde_json::Value = serde_json::from_str(&json_text).expect("JSON do Mico válido");
    let metas = v
        .get("metas")
        .and_then(|m| m.as_array())
        .expect("array metas");
    assert!(!metas.is_empty());
    for item in metas.iter().take(5) {
        let id = item.get("id").and_then(|i| i.as_str()).unwrap_or("");
        assert!(is_valid_imdb(id));
    }
}
