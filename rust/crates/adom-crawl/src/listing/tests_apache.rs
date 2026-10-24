use super::*;

// ── Testes com Fixtures Reais do ApacheTorrents ─────────────────────────

const APACHE_PAGE1: &str =
    include_str!("../../../../../test/fixtures/crawl/apachetorrent/pagina-1-cheia.html");
const APACHE_PAGE_END: &str =
    include_str!("../../../../../test/fixtures/crawl/apachetorrent/pagina-fim-calcanhar.html");
const APACHE_POST_FILME: &str =
    include_str!("../../../../../test/fixtures/crawl/apachetorrent/post-filme.html");
const APACHE_POST_SERIE: &str =
    include_str!("../../../../../test/fixtures/crawl/apachetorrent/post-serie.html");
const APACHE_POST_DESENHO: &str =
    include_str!("../../../../../test/fixtures/crawl/apachetorrent/post-serie-desenho.html");

#[test]
fn test_apache_listing_page_real_fixture() {
    assert_eq!(apache_count_listing_cards(APACHE_PAGE1), 20);
    let cards = apache_parse_listing_cards(APACHE_PAGE1, "https://apachetorrents.com/");
    assert_eq!(
        cards.len(),
        20,
        "20 obras unicas apos deduplicacao de capa e titulo"
    );

    let movies: Vec<_> = cards
        .iter()
        .filter(|c| c.kind == CrawlPageKind::Movie)
        .collect();
    let series: Vec<_> = cards
        .iter()
        .filter(|c| c.kind == CrawlPageKind::TvShow)
        .collect();
    assert_eq!(movies.len(), 11, "11 filmes na pagina 1");
    assert_eq!(series.len(), 9, "9 series na pagina 1");

    // Futurama e Presidente Curtis sao desenhos com temporada no slug -> tv_show
    assert!(series
        .iter()
        .any(|c| c.url.contains("futurama-14a-temporada")));
    assert!(series
        .iter()
        .any(|c| c.url.contains("presidente-curtis-1a-temporada")));

    // Pagina fim calcanhar tem 15 cards
    assert_eq!(apache_count_listing_cards(APACHE_PAGE_END), 15);
    let end_cards = apache_parse_listing_cards(APACHE_PAGE_END, "https://apachetorrents.com/");
    assert_eq!(end_cards.len(), 15);
}

#[test]
fn test_apache_posts_real_fixtures() {
    // post-filme.html
    assert_eq!(
        apache_page_kind_of(APACHE_POST_FILME),
        Some(CrawlPageKind::Movie)
    );
    assert_eq!(
        apache_parse_imdb_id(APACHE_POST_FILME),
        Some("tt5125894".to_string())
    );
    assert_eq!(
        apache_ficha_original_title(APACHE_POST_FILME),
        Some("Poms".to_string())
    );
    assert_eq!(apache_ficha_size_bytes(APACHE_POST_FILME), Some(1911260447)); // 1.78 GB

    // post-serie.html
    assert_eq!(
        apache_page_kind_of(APACHE_POST_SERIE),
        Some(CrawlPageKind::TvShow)
    );
    assert_eq!(
        apache_ficha_original_title(APACHE_POST_SERIE),
        Some("Lanterns".to_string())
    );

    // post-serie-desenho.html (Desenho e ambiguo no item-lead -> None)
    assert_eq!(apache_page_kind_of(APACHE_POST_DESENHO), None);
    assert_eq!(
        apache_parse_imdb_id(APACHE_POST_DESENHO),
        Some("tt37692332".to_string())
    );
    assert_eq!(
        apache_ficha_original_title(APACHE_POST_DESENHO),
        Some("President Curtis".to_string())
    );
}
