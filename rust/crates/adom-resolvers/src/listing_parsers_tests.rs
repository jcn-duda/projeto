//! Testes dos parsers de listagem (`listing_parsers`).

use super::*;

/// Recorte REAL da listagem do TorrentGalaxy (2026-10-24): 3 linhas
/// `div.tgxtablerow` de "batman", com tamanho, data relativa, seeders e poster
/// na própria linha (o magnet do TGx vive no post de detalhe).
const TGX: &str = include_str!("../tests/fixtures/torrentgalaxy_listing.html");

#[test]
fn comando_extrai_posts() {
    let html = r#"<article class="blog-view"><h2 class="entry-title"><a href="/x" title="Filme X">X</a></h2><img src="i.jpg"></article>"#;
    let p = parse_comando_posts(html, "https://c.tv");
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].title, "Filme X");
    assert!(p[0].poster.is_some());
}

#[test]
fn tdf_extrai_posts() {
    let html = r#"<div class="title"><a href="/y" title="Filme Y 2024">Y...</a></div>"#;
    let p = parse_tdf_posts(html, "https://tdf.com");
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].title, "Filme Y 2024");
}

#[test]
fn hdr_extrai_card() {
    let html = r#"<a href="/z" class="media-card-link"><div class="media-card-cover"><img data-src="p.jpg"></div><div class="media-card-title">Filme Z</div></a>"#;
    let p = parse_hdr_posts(html, "https://hdr.net");
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].title, "Filme Z");
}

#[test]
fn rede_extrai_item() {
    let html = r#"<div class="item"><a href="/filmes/f" title="Filme W (2023)">x</a></div>"#;
    let p = parse_rede_posts(html, "https://rede.com");
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].title, "Filme W (2023)");
}

#[test]
fn vaca_extrai_json() {
    let json = r#"[{"title":"Obra A","link":"/obra-a","thumbnail":"i.jpg"}]"#;
    let p = parse_vaca_posts(json, "https://vaca.com");
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].title, "Obra A");
}

#[test]
fn apache_extrai_capa() {
    let html = r#"<div class='capa-item'><h2 class='capa-titulo'><a href='/v' title='Filme V'>t</a></h2></div>"#;
    let p = parse_apache_posts(html, "https://apa.com");
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].title, "Filme V");
}

#[test]
fn bludv_extrai_post() {
    let html = r#"<div class="post"><div class="title"><a href='/u'>Filme U</a></div></div>"#;
    let p = parse_bludv_posts(html, "https://bludv.com");
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].title, "Filme U");
}

#[test]
fn nerd_extrai_article() {
    let html = r#"<article class="col"><div class="image"><a href="/t" title="Filme T"></a></div></article>"#;
    let p = parse_nerd_posts(html, "https://nerd.com");
    assert_eq!(p.len(), 1);
    assert_eq!(p[0].title, "Filme T");
}

#[test]
fn dispatch_e_genericos() {
    let html = r#"<div class="title"><a href="/x" title="Teste">x</a></div>"#;
    assert_eq!(
        parse_listing_posts("torrentdosfilmes", html, "https://tdf.com").len(),
        1
    );
    assert!(parse_listing_posts("desconhecido", html, "https://x.com").is_empty());
    let gen = r#"<div class="title"><a href="/l" title="Lista de Filmes 2024">L</a></div>"#;
    assert!(parse_tdf_posts(gen, "https://tdf.com").is_empty());
}

/// A linha do TGx é a mais RICA da lista: título, path de detalhe, tamanho,
/// data RELATIVA, seeders/leechers, poster e categoria — tudo na listagem.
#[test]
fn torrentgalaxy_extrai_a_linha_rica() {
    let rows = torrentgalaxy::parse_rows(TGX, "https://torrentgalaxy.one");
    assert_eq!(rows.len(), 3);
    let row = &rows[0];
    assert_eq!(
        row.title,
        "Batman.Knightfall.Part.1.Knightfall.2026.1080p.WEBRip.10Bit.DDP5.1.x265-NeoNoir"
    );
    assert_eq!(
        row.url,
        "https://torrentgalaxy.one/post-detail/960407/batman-knightfall-part-1-knightfall-2026-1080p-webrip-10bit-ddp5-1-x265-neonoir/"
    );
    assert_eq!(row.size.as_deref(), Some("956.3 MB"));
    assert_eq!(row.date.as_deref(), Some("1 month, 4 weeks"));
    assert_eq!(row.seeders, Some(1026));
    assert_eq!(row.leechers, Some(168));
    assert_eq!(row.category.as_deref(), Some("Movies"));
    assert_eq!(
        row.poster.as_deref(),
        Some("https://i.rar.pics/009/ebe7c6c1fd443fa2f577.jpg")
    );
    // A segunda linha tem outro tamanho e outra data: a extração não pode
    // estar lendo o rodapé da tabela (que repete os mesmos valores).
    assert_eq!(rows[1].size.as_deref(), Some("1.5 GB"));
    assert_eq!(rows[1].date.as_deref(), Some("1 month, 2 weeks"));
    assert_eq!(rows[1].seeders, Some(1017));
}

/// O dispatch por nome do site devolve a linha do TGx (título + URL + poster).
#[test]
fn torrentgalaxy_dispatch_de_listagem() {
    let posts = parse_listing_posts("torrentgalaxy", TGX, "https://torrentgalaxy.one");
    assert_eq!(posts.len(), 3);
    assert_eq!(
        posts[0].title,
        "Batman.Knightfall.Part.1.Knightfall.2026.1080p.WEBRip.10Bit.DDP5.1.x265-NeoNoir"
    );
    assert!(posts[0]
        .url
        .starts_with("https://torrentgalaxy.one/post-detail/960407/"));
    assert_eq!(
        posts[0].poster.as_deref(),
        Some("https://i.rar.pics/009/ebe7c6c1fd443fa2f577.jpg")
    );
}
