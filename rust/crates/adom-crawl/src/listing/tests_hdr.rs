use super::*;

// ── Testes com Fixtures Reais do HDRTorrents ────────────────────────────

const HDR_PAGE1: &str =
    include_str!("../../../../../test/fixtures/crawl/hdrtorrents/pagina-1-cheia.html");
const HDR_PAGE_END: &str =
    include_str!("../../../../../test/fixtures/crawl/hdrtorrents/pagina-fim-calcanhar.html");
const HDR_POST_FILME: &str =
    include_str!("../../../../../test/fixtures/crawl/hdrtorrents/post-filme.html");
const HDR_POST_SERIE: &str =
    include_str!("../../../../../test/fixtures/crawl/hdrtorrents/post-serie.html");

#[test]
fn test_hdr_listing_page_real_fixture() {
    assert_eq!(hdr_count_listing_cards(HDR_PAGE1), 20);
    assert_eq!(hdr_count_listing_cards(HDR_PAGE_END), 15);

    let cards = hdr_parse_listing_cards(HDR_PAGE1, "https://hdrtorrents.net/");
    assert_eq!(cards.len(), 20);

    let movies: Vec<_> = cards
        .iter()
        .filter(|c| c.kind == CrawlPageKind::Movie)
        .collect();
    let series: Vec<_> = cards
        .iter()
        .filter(|c| c.kind == CrawlPageKind::TvShow)
        .collect();
    assert_eq!(movies.len(), 11);
    assert_eq!(series.len(), 9);

    assert_eq!(
        cards[0].url,
        "https://hdrtorrents.net/futurama-14a-temporada-torrent-download/"
    );
    assert_eq!(cards[0].kind, CrawlPageKind::TvShow);
}

const HDR_POST_SERIE_AGREGADA: &str =
    include_str!("../../../../../test/fixtures/crawl/hdrtorrents/post-serie-agregada.html");

#[test]
fn test_hdr_posts_real_fixtures() {
    // post-filme.html (snippet sem <main> retorna None)
    assert_eq!(hdr_page_kind_of(HDR_POST_FILME), None);
    assert!(!hdr_declares_series(HDR_POST_FILME));
    assert_eq!(
        hdr_parse_imdb_id(HDR_POST_FILME),
        Some("tt1197624".to_string())
    );

    // post-serie.html (snippet sem <main> retorna None)
    assert_eq!(hdr_page_kind_of(HDR_POST_SERIE), None);
    assert_eq!(
        hdr_parse_imdb_id(HDR_POST_SERIE),
        Some("tt10893694".to_string())
    );

    // post-serie-agregada.html traz <main class="container my-3" itemscope itemtype="https://schema.org/TVSeries">
    assert_eq!(
        hdr_page_kind_of(HDR_POST_SERIE_AGREGADA),
        Some(CrawlPageKind::TvShow)
    );
    assert!(hdr_declares_series(HDR_POST_SERIE_AGREGADA));

    // Sintético com Movie
    let synthetic_movie = r#"<main class="container my-3" itemscope itemtype="https://schema.org/Movie"><h1>Filme</h1></main>"#;
    assert_eq!(
        hdr_page_kind_of(synthetic_movie),
        Some(CrawlPageKind::Movie)
    );
    assert!(!hdr_declares_series(synthetic_movie));
}
