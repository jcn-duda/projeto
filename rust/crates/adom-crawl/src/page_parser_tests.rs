#[cfg(test)]
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
