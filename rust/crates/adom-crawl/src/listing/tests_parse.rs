use super::*;

// ── Testes de parse_size ─────────────────────────────────────────────────

#[test]
fn test_parse_size_exact_multipliers() {
    assert_eq!(parse_size("52.4 GB"), Some(56264071578));
    assert_eq!(parse_size("2,45 GB"), Some(2630667469));
    assert_eq!(parse_size("2,8 gb"), Some(3006477107));
    assert_eq!(parse_size("950 MB"), Some(996147200));
    assert_eq!(parse_size("950 mb"), Some(996147200));
    assert_eq!(parse_size("0.8 TB"), Some(879609302221));
    assert_eq!(parse_size("1,5 Tb"), Some(1649267441664));
    assert_eq!(parse_size("500 KB"), Some(512000));
    assert_eq!(parse_size("500 kb"), Some(512000));
    assert_eq!(parse_size("1 KB"), Some(1024));
    assert_eq!(parse_size("1.78 GB"), Some(1911260447));
    assert_eq!(parse_size("invalido"), None);
    assert_eq!(parse_size(""), None);
}

// ── Testes de Regra 1: markup_of sem backreference ───────────────────────

#[test]
fn test_markup_of_without_backreference() {
    let input = "<div><!-- comentario fechado --><script type=\"text/javascript\">alert('oi');</script><span>teste</span><style>.cor { color: red; }</style></div>";
    let cleaned = apache_markup_of(input);
    assert!(!cleaned.contains("alert"));
    assert!(!cleaned.contains("color: red"));
    assert!(!cleaned.contains("comentario fechado"));
    assert!(cleaned.contains("teste"));
}

// ── Testes de Detecção de IMDb e Widgets ────────────────────────────────

#[test]
fn test_imdb_widget_filtration() {
    let widget = r#"<a href="https://www.imdb.com/title/tt1959490/?ref_=tt_plg_rt">7.0</a>"#;
    assert_eq!(extract_single_imdb_id(widget), None);

    let with_valid = format!(
        r#"{}<a href="https://www.imdb.com/title/tt0340163/">IMDb</a>"#,
        widget
    );
    assert_eq!(
        extract_single_imdb_id(&with_valid),
        Some("tt0340163".to_string())
    );

    let ambiguous = r#"<a href="https://www.imdb.com/title/tt0340163/">IMDb</a><a href="https://www.imdb.com/title/tt1234567/">IMDb</a>"#;
    assert_eq!(extract_single_imdb_id(ambiguous), None);

    let commented = r#"<!-- <a href="https://www.imdb.com/title/tt1959490/">widget</a> -->"#;
    assert_eq!(apache_parse_imdb_id(commented), None);

    let fake_domain = r#"<a href="https://notimdb.com/title/tt1234567/">falso domínio</a>"#;
    assert_eq!(extract_single_imdb_id(fake_domain), None);

    assert_eq!(
        extract_single_imdb_id(
            r#"<a href="https://www.imdb.com/title/tt0340163/listend">IMDb</a>"#
        ),
        Some("tt0340163".to_string())
    );
    assert_eq!(
        extract_single_imdb_id(r#"<a href="https://m.imdb.com/title/tt0340163/">IMDb</a>"#),
        Some("tt0340163".to_string())
    );
    assert_eq!(
        extract_single_imdb_id(
            r#"<a href="https://www.imdb.com/title/tt1234567/?ref_=tt_review">obra</a>"#
        ),
        Some("tt1234567".to_string())
    );
}

// ── Testes de Paginação e Reconhecimento ─────────────────────────────────

#[test]
fn test_pagination_rules() {
    assert!(is_listing_end(15, 15, 20));
    assert!(!is_listing_end(20, 20, 20));
    assert!(!is_listing_end(19, 20, 20));

    assert!(is_repeated_page(0, false));
    assert!(!is_repeated_page(0, true));
    assert!(!is_repeated_page(5, false));

    assert_eq!(check_listing_recognition(20, 20, 20), Ok(()));
    assert_eq!(
        check_listing_recognition(20, 20, 0),
        Err("nenhuma-obra-no-host")
    );
    assert_eq!(
        check_listing_recognition(20, 0, 0),
        Err("cards-nao-reconhecidos")
    );
    assert_eq!(check_listing_recognition(0, 0, 0), Err("nenhum-card"));
}

// ── Testes de Slugs de Obra e Temporada ──────────────────────────────────

#[test]
fn test_slug_rules() {
    assert!(apache_is_work_path("/filme-exemplo-baixar-torrent/"));
    assert!(!apache_is_work_path("/pagina/2/"));
    assert!(!apache_is_work_path("/filmes/"));

    assert!(hdr_is_work_path("/filme-exemplo-torrent-download/"));
    assert!(!hdr_is_work_path("/pagina/2/"));
    assert!(!hdr_is_work_path("/desenhos/"));

    assert!(apache_is_season_slug("serie-1a-temporada-baixar-torrent"));
    assert!(apache_is_season_slug("serie-14a-temporada-baixar-torrent"));
    assert!(apache_is_season_slug("serie-3-temporada-baixar-torrent"));
    assert!(!apache_is_season_slug("filme-comum-baixar-torrent"));

    assert_eq!(
        apache_kind_from_work_slug("serie-1a-temporada-baixar-torrent"),
        CrawlPageKind::TvShow
    );
    assert_eq!(
        apache_kind_from_work_slug("filme-comum-baixar-torrent"),
        CrawlPageKind::Movie
    );
}
