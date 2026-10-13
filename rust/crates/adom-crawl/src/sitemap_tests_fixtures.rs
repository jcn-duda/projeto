#[cfg(test)]
use super::*;
#[cfg(test)]
use std::fs;
#[cfg(test)]
use std::path::PathBuf;

#[cfg(test)]
fn fixture_path(subpath: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/fixtures")
        .join(subpath)
}

#[cfg(test)]
fn read_fixture(subpath: &str) -> String {
    let path = fixture_path(subpath);
    fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("falha ao ler fixture {}: {:?}", path.display(), err))
}

#[test]
fn test_fixture_bludv_post_sitemap() {
    let xml = read_fixture("crawl/bludv/post-sitemap.xml");
    let entries = parse_sitemap_entries(&xml);
    assert_eq!(entries.len(), 1001);
    assert_eq!(entries[0].loc, "https://bludvfilmes1.xyz/");
    // Nenhuma entrada contém upload de imagem
    assert!(!entries
        .iter()
        .any(|e| e.loc.contains("/wp-content/uploads/")));

    let config = SitemapSiteConfig::bludv();
    let is_host = |h: &str| h == "bludvfilmes1.xyz";
    // A primeira linha é a home '/' e é recusada como obra
    assert_eq!(
        config.to_work_url(&entries[0].loc, "https://bludvfilmes1.xyz", is_host),
        None
    );

    // Obra real é aceita
    let work_entry = entries
        .iter()
        .find(|e| e.loc.contains("espirito-de-lobo"))
        .expect("espirito-de-lobo deve estar presente");
    assert!(config
        .to_work_url(&work_entry.loc, "https://bludvfilmes1.xyz", is_host)
        .is_some());
}

#[test]
fn test_fixture_bludv_sitemap_index() {
    let xml = read_fixture("crawl/bludv/sitemap-index.xml");
    let config = SitemapSiteConfig::bludv();
    let is_host = |h: &str| h == "bludvfilmes1.xyz";
    let locs = config.parse_sitemap_index_locs(&xml, "https://bludvfilmes1.xyz", is_host);
    assert_eq!(locs.len(), 18);
    assert_eq!(locs[0], "https://bludvfilmes1.xyz/post-sitemap.xml");
    assert_eq!(locs[17], "https://bludvfilmes1.xyz/post-sitemap18.xml");
}

#[test]
fn test_fixture_vaca_movie_sitemap11() {
    let xml = read_fixture("crawl/vaca/movie-sitemap11.xml");
    let entries = parse_sitemap_entries(&xml);
    assert_eq!(entries.len(), 118);
    assert!(entries.iter().all(|e| !e.lastmod.is_empty()));
}

#[test]
fn test_fixture_vaca_pages_imdb() {
    let torrent_page = read_fixture("crawl/vaca/movie-page-torrent.html");
    assert_eq!(
        parse_vaca_imdb_id(&torrent_page),
        Some("tt1706620".to_string())
    );

    let no_imdb_page = read_fixture("crawl/vaca/movie-page-no-imdb.html");
    assert_eq!(parse_vaca_imdb_id(&no_imdb_page), None);
}

#[test]
fn test_fixture_bludv_post_movie_imdb() {
    let post_movie = read_fixture("crawl/bludv/post-movie.html");
    assert_eq!(
        parse_bludv_imdb_id(&post_movie),
        Some("tt3416744".to_string())
    );
}

#[test]
fn test_fixture_comandotorrents_sitemaps() {
    let xml = read_fixture("crawl/comandotorrents/post-sitemap.xml");
    let entries = parse_sitemap_entries(&xml);
    assert_eq!(entries.len(), 6);

    let config = SitemapSiteConfig::comandotorrents();
    let is_host = |h: &str| h == "comandotorrents.to";

    let work_urls: Vec<_> = entries
        .iter()
        .filter_map(|e| config.to_work_url(&e.loc, "https://comandotorrents.to", is_host))
        .collect();
    // Das 6 entradas: home '/', evil host e feed saem -> sobram 3 obras
    assert_eq!(work_urls.len(), 3);
}

#[test]
fn test_fixture_nerdfilmes_post_sitemap() {
    let xml = read_fixture("crawl/nerdfilmes/post-sitemap.xml");
    let entries = parse_sitemap_entries(&xml);
    assert_eq!(entries.len(), 40);
    assert_eq!(
        entries[0].loc,
        "https://www.filmesviatorrenthd.net/lanternas-1a-temporada-2026/"
    );
    assert_eq!(entries[0].lastmod, "2026-09-28T01:15:24+00:00");
}

#[test]
fn test_fixture_redetorrent_dual_format() {
    let xml = read_fixture("redetorrent/movies-sitemap-cdata.xml");
    let html = read_fixture("redetorrent/movies-sitemap.html");

    let from_xml = parse_sitemap_rows(&xml);
    let from_html = parse_sitemap_rows(&html);

    assert_eq!(from_xml.len(), 11);
    assert_eq!(from_html.len(), 11);
    assert_eq!(
        from_xml[0].loc,
        "https://www.redetorrent.xyz/filmes/coringa-delirio-a-dois/"
    );
    assert_eq!(from_xml[0].lastmod, "2026-02-06T14:22:00Z");
    assert_eq!(
        from_html[0].loc,
        "https://www.redetorrent.xyz/filmes/coringa-delirio-a-dois/"
    );
    assert_eq!(from_html[0].lastmod, "2026-02-06T14:22:00Z");

    // Ambas as leituras devem ser equivalentes
    assert_eq!(from_xml, from_html);
}
