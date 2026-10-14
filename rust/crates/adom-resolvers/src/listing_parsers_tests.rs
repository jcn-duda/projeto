//! Testes dos parsers de listagem (`listing_parsers`).

use super::*;

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
