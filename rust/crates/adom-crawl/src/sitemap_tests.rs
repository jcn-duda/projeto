#[cfg(test)]
use super::*;
#[cfg(test)]
use url::Url;

#[test]
fn test_is_xml_sitemap_shape() {
    assert!(is_xml_sitemap_shape(
        "<URLSET><url><loc><![CDATA[https://site.test/]]></loc></url></URLSET>"
    ));
    assert!(is_xml_sitemap_shape(
        "<sitemapindex><sitemap><loc>https://site.test/post.xml</loc></sitemap></sitemapindex>"
    ));
    assert!(is_xml_sitemap_shape(
        "<url><loc>https://site.test/</loc></url>"
    ));
    assert!(is_xml_sitemap_shape("<loc>https://site.test/</loc>"));

    // Comentários são ignorados
    assert!(!is_xml_sitemap_shape(
        "<html><!-- <urlset><url/></urlset> --></html>"
    ));
    // <image:loc> não é sitemap XML
    assert!(!is_xml_sitemap_shape(
        "<image:loc>https://site.test/image.jpg</image:loc>"
    ));
    // Lookahead exige [\s/>]: <location> não casa
    assert!(!is_xml_sitemap_shape(
        "<location>https://site.test/</location>"
    ));
    // HTML genérico não é XML
    assert!(!is_xml_sitemap_shape(
        "<html><body>Just a moment... <table><tr><td>challenge</td></tr></table></body></html>"
    ));
}

#[test]
fn test_is_vaca_sitemap_shape() {
    let empty_viewer = r#"<table id="sitemap"><thead><tr><th>URL</th><th>Images</th><th>Last Modified</th></tr></thead><tbody></tbody></table>"#;
    assert!(is_vaca_sitemap_shape(empty_viewer));

    let xml = "<urlset><url><loc>https://site.test/</loc></url></urlset>";
    assert!(is_vaca_sitemap_shape(xml));

    // HTML genérico não casa
    assert!(!is_vaca_sitemap_shape(
        "<html><table><tr><td>challenge</td></tr></table></html>"
    ));
}

#[test]
fn test_assert_sitemap_scope() {
    assert_eq!(
        assert_sitemap_scope(0, 0, false),
        Err(SitemapScopeError::FormatoDesconhecido)
    );
    assert_eq!(
        assert_sitemap_scope(0, 0, true),
        Err(SitemapScopeError::SemEntradasReconhecidas)
    );
    assert_eq!(
        assert_sitemap_scope(1, 0, true),
        Err(SitemapScopeError::SemObrasDoEscopo)
    );
    assert_eq!(assert_sitemap_scope(1, 1, true), Ok(()));

    assert_eq!(
        sitemap_failure_message("https://site/sitemap.xml", "sitemap_formato_desconhecido"),
        "sitemap_formato_desconhecido"
    );
    assert_eq!(
        sitemap_failure_message(
            "https://site/sitemap.xml",
            "sitemap_sem_entradas_reconhecidas"
        ),
        "https://site/sitemap.xml: sitemap_sem_entradas_reconhecidas"
    );
}

#[test]
fn test_parse_viewer_entries() {
    let sample = r#"<tr>
          <td><a href="https://vaqueirofilmes.com/pt/movie/maquina-de-guerra/">obra</a></td>
          <td>1</td>
          <td>2026-03-15 01:36 +00:00</td>
        </tr>
        <tr>
          <td><a href="https://vaqueirofilmes.com/pt/movie/outro/?a=1&amp;b=2">outro</a></td>
          <td>2026-04-10 10:20Z</td>
        </tr>"#;

    let entries = parse_viewer_entries(sample);
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0].loc,
        "https://vaqueirofilmes.com/pt/movie/maquina-de-guerra/"
    );
    assert_eq!(entries[0].lastmod, "2026-03-15T01:36:00+00:00");

    assert_eq!(
        entries[1].loc,
        "https://vaqueirofilmes.com/pt/movie/outro/?a=1&b=2"
    );
    assert_eq!(entries[1].lastmod, "2026-04-10T10:20:00+00:00");
}

#[test]
fn test_parse_rendered_lastmod() {
    assert_eq!(
        parse_rendered_lastmod("6 de February de 2026", Some("14:22")),
        "2026-02-06T14:22:00Z"
    );
    assert_eq!(
        parse_rendered_lastmod("2026-02-06", Some("14:22:15")),
        "2026-02-06T14:22:15Z"
    );
    assert_eq!(parse_rendered_lastmod("0000-00-00", Some("00:00")), "");
    assert_eq!(parse_rendered_lastmod("", None), "");
}

#[test]
fn test_parse_sitemap_entries_xml() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url>
            <loc><![CDATA[https://site.test/filme-a/?x=1&amp;y=2]]></loc>
            <lastmod><![CDATA[2026-01-02T03:04:05+00:00]]></lastmod>
          </url>
          <url>
            <loc>https://site.test/sem-data/</loc>
            <lastmod>0000-00-00</lastmod>
          </url>
        </urlset>"#;

    let entries = parse_sitemap_entries(xml);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].loc, "https://site.test/filme-a/?x=1&y=2");
    assert_eq!(entries[0].lastmod, "2026-01-02T03:04:05+00:00");

    assert_eq!(entries[1].loc, "https://site.test/sem-data/");
    assert_eq!(entries[1].lastmod, ""); // 0000-00-00 vira vazio
}

#[test]
fn test_parse_sitemap_index_locs() {
    let index = r#"<sitemapindex>
          <sitemap><loc>https://bludv.xyz/post-sitemap.xml</loc></sitemap>
          <sitemap><loc>https://bludv.xyz/post-sitemap2.xml</loc></sitemap>
          <sitemap><loc>https://evil.example/post-sitemap3.xml</loc></sitemap>
          <sitemap><loc>https://bludv.xyz/category-sitemap.xml</loc></sitemap>
        </sitemapindex>"#;

    let locs = parse_sitemap_index_locs(index, "https://bludv.xyz", |h| h == "bludv.xyz");
    assert_eq!(
        locs,
        vec![
            "https://bludv.xyz/post-sitemap.xml".to_string(),
            "https://bludv.xyz/post-sitemap2.xml".to_string(),
        ]
    );
}

#[test]
fn test_is_work_path_and_to_work_url() {
    assert!(is_work_path("/furiosa-uma-saga-mad-max/", None));
    assert!(is_work_path("/bancarios-2020/", None));
    assert!(!is_work_path("/", None));
    assert!(!is_work_path("/feed/", None));
    assert!(!is_work_path("/link.php/", None));
    assert!(!is_work_path("/genero/acao/", None));

    let is_host = |h: &str| h == "comandotorrents.to";
    assert_eq!(
        to_work_url(
            "https://comandotorrents.to/furiosa/",
            "https://comandotorrents.to",
            is_host
        ),
        Some(Url::parse("https://comandotorrents.to/furiosa/").unwrap())
    );
    assert_eq!(
        to_work_url(
            "https://evil.example/furiosa/",
            "https://comandotorrents.to",
            is_host
        ),
        None
    );
    assert_eq!(
        to_work_url(
            "https://comandotorrents.to/feed/",
            "https://comandotorrents.to",
            is_host
        ),
        None
    );
}

#[test]
fn test_kind_from_slug() {
    assert_eq!(
        kind_from_slug("https://site.test/smallville-10a-temporada/"),
        CrawlPageKind::TvShow
    );
    assert_eq!(
        kind_from_slug("https://site.test/filme-normal-2024/"),
        CrawlPageKind::Movie
    );
    assert!(is_season_slug("/lanternas-1a-temporada-2026/"));
    assert!(!is_season_slug("/filme-antigo/"));

    let bludv_patterns = &["temporada", "minis+erie", "serie-completa"];
    assert_eq!(
        kind_from_slug_with_patterns("/redencao-minisserie-completa/", bludv_patterns),
        CrawlPageKind::TvShow
    );
    assert_eq!(
        kind_from_slug_with_patterns("/mr-bean-serie-completa/", bludv_patterns),
        CrawlPageKind::TvShow
    );
    assert_eq!(
        kind_from_slug_with_patterns("/uma-noite-fora-de-serie/", bludv_patterns),
        CrawlPageKind::Movie
    );
}

#[test]
fn test_is_imdb_widget_reference() {
    assert!(is_imdb_widget_reference("?ref_=tt_plg_rt"));
    assert!(is_imdb_widget_reference("/ref_=tt_123"));
    assert!(is_imdb_widget_reference("/list/ls1234/"));
    assert!(!is_imdb_widget_reference(""));
    assert!(!is_imdb_widget_reference("/"));
}

#[test]
fn test_parse_imdb_id() {
    let html_single = r#"<div>
          <a href="https://www.imdb.com/title/tt1234567/">IMDb</a>
        </div>"#;
    assert_eq!(parse_imdb_id(html_single), Some("tt1234567".to_string()));

    // Em comentário não conta
    let html_comment = r#"<div>
          <!-- <a href="https://www.imdb.com/title/tt9999999/">IMDb</a> -->
        </div>"#;
    assert_eq!(parse_imdb_id(html_comment), None);

    // Com widget de recomendação não conta
    let html_widget = r#"<div>
          <a href="https://www.imdb.com/title/tt1234567/?ref_=tt_plg_rt">IMDb</a>
        </div>"#;
    assert_eq!(parse_imdb_id(html_widget), None);

    // Múltiplos distintos é ambíguo
    let html_multi = r#"<div>
          <a href="https://www.imdb.com/title/tt1111111/">IMDb</a>
          <a href="https://www.imdb.com/title/tt2222222/">IMDb</a>
        </div>"#;
    assert_eq!(parse_imdb_id(html_multi), None);
}

#[test]
fn test_parse_vaca_imdb_id() {
    let html = r#"<li><b>Avaliação da IMDb:</b> <a href="https://www.imdb.com/title/tt1706620/" target="_blank">7.1</a></li>"#;
    assert_eq!(parse_vaca_imdb_id(html), Some("tt1706620".to_string()));

    let no_anchor = r#"<li><b>Classificação:</b> 16</li>"#;
    assert_eq!(parse_vaca_imdb_id(no_anchor), None);
}

#[test]
fn test_parse_bludv_imdb_id() {
    let html = r#"<strong>IMDb:</strong> <a href="https://www.imdb.com/title/tt3416744/">7.4</a>"#;
    assert_eq!(parse_bludv_imdb_id(html), Some("tt3416744".to_string()));
}
