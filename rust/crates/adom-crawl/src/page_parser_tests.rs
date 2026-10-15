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

/// (a) Post do BLUDV que SÓ publica o botão do portão de anúncio: vira
/// PENDENTE de portão (`gate-pending` com o href), nunca `no-torrent` nem
/// erro — o executor de fundo paga depois.
#[test]
fn test_parse_crawl_page_bludv_so_gate_vira_pendente() {
    let html = r#"
        <h1>Matrix (1999)</h1>
        <b>IMDb:</b> <a href="https://www.imdb.com/title/tt0133093/">7.8</a>
        <div class="download-links">
            <a href="https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609" target="_blank">DOWNLOAD TORRENT</a>
        </div>
    "#;
    let res = parse_crawl_page(
        "bludv",
        "movie",
        "https://bludv.com/filmes/matrix-1999-download/",
        html,
    );
    assert_eq!(res.status, "gate-pending");
    assert_eq!(
        res.gate.as_deref(),
        Some("https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609"),
        "href do portão vai para o executor de fundo"
    );
    assert!(res.releases.is_empty());
    // Metadados de obra colhidos na leitura (o executor não volta ao site).
    assert_eq!(res.title, Some("Matrix".to_string()));
    assert_eq!(res.year, Some(1999));
    assert_eq!(res.imdb, Some("tt0133093".to_string()));
}

/// (d) Post MISTO (botões legados com magnet + portão) continua como hoje: os
/// legados colhem normalmente e o portão é ignorado quando sobra link.
#[test]
fn test_parse_crawl_page_bludv_misto_preserva_legados() {
    let html = r#"
        <h1>Matrix (1999)</h1>
        <b>IMDb:</b> <a href="https://www.imdb.com/title/tt0133093/">7.8</a>
        <div class="download-links">
            <a href="magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=Matrix.1999.1080p.DUAL">Download 1080p (2.5 GB)</a>
            <a href="https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609" target="_blank">DOWNLOAD TORRENT</a>
        </div>
    "#;
    let res = parse_crawl_page(
        "bludv",
        "movie",
        "https://bludv.com/filmes/matrix-1999-download/",
        html,
    );
    assert_eq!(res.status, "done", "legado colhido: comportamento de hoje");
    assert_eq!(res.releases.len(), 1);
    assert!(res.releases[0].magnet.starts_with("magnet:"));
    assert_eq!(res.gate, None, "portão não vira pendência quando há link");
}
