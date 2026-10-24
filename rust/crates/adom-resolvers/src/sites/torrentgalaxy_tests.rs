//! Testes do TorrentGalaxy: o magnet da página de DETALHE, a data relativa do
//! TGx e o cartão que o Cardigann lê (`div.posts > div.release`).
//!
//! As fixtures são recortes REAIS do site (medidos em 2026-10-24): o post em
//! `tests/fixtures/torrentgalaxy_detail.html`. A listagem real fica em
//! `tests/fixtures/torrentgalaxy_listing.html` e é testada no parser de
//! listagem (`listing_parsers_tests.rs`).

use adom_crawl::profile_parsers::ResolverLink;

use super::*;
use crate::common::http_date::date_utc_ms;
use crate::common::{SearchItem, SitePost};

/// Página de detalhe real: o magnet está no botão `dl-magnet`.
const DETALHE: &str = include_str!("../../tests/fixtures/torrentgalaxy_detail.html");

/// O instante da medição (2026-10-24T00:00:00Z), congelado para a data
/// relativa não depender do relógio do teste.
fn agora() -> i64 {
    date_utc_ms(2026, 9, 24)
}

/// O magnet sai da página de detalhe — o PRIMEIRO, que é o do botão
/// "Magnet Download" (a página tem outros `magnet:` depois, no `data-magnet`
/// do botão de copiar).
#[test]
fn magnet_da_pagina_de_detalhe() {
    let magnet = extract_magnet(DETALHE).expect("magnet do post");
    assert!(magnet.starts_with("magnet:?xt=urn:btih:E50CCB005CD4AB1A78390508F0E606F9ED0CB571"));
    // O HTML publica `&amp;` no href: sem decodificar, o magnet cru quebrava
    // o player (o `&` virava "&amp;" na URI).
    assert!(magnet.contains("&dn="), "entidade nao decodificada");
    assert!(!magnet.contains("&amp;"));
}

/// Página sem magnet devolve `None` — o `/resolve` falha com "sem_magnet" em
/// vez de devolver lixo ao Jackett.
#[test]
fn pagina_sem_magnet_nao_inventa_link() {
    assert!(extract_magnet("<html><body>sem magnet aqui</body></html>").is_none());
    // `magnet:` sem `xt=urn:btih` não é o magnet do TGx (não dá pra casar por
    // tracker nem baixar).
    assert!(extract_magnet(r#"<a data-magnet="magnet:?dn=qualquer-coisa">"#).is_none());
}

/// A data RELATIVA do TGx ("1 month, 4 weeks") vira a data absoluta que o
/// Cardigann faz `dateparse: dd/MM/yyyy`. As duas maiores unidades do site se
/// SOMAM (1 mês + 4 semanas = 58 dias).
#[test]
fn data_relativa_vira_dd_mm_yyyy() {
    let now = agora();
    assert_eq!(
        relative_to_date("1 month, 4 weeks", now).as_deref(),
        Some("27/08/2026")
    );
    assert_eq!(
        relative_to_date("1 month, 2 weeks", now).as_deref(),
        Some("10/09/2026")
    );
    assert_eq!(
        relative_to_date("3 days", now).as_deref(),
        Some("21/10/2026")
    );
    assert!(relative_to_date("sem data", now).is_none());
}

/// O termo vai no PATH, depois de `keywords:` — o `/?s=` do WordPress não
/// existe no TGx (devolve a home).
#[test]
fn url_de_busca_vai_no_path() {
    assert_eq!(
        search_url("https://torrentgalaxy.one", "batman").unwrap(),
        "https://torrentgalaxy.one/get-posts/keywords:batman"
    );
    // O `:` é o separador do path: saneado para não partir a busca em dois.
    assert_eq!(
        search_url("https://torrentgalaxy.one", "batman: begins").unwrap(),
        "https://torrentgalaxy.one/get-posts/keywords:batman%20begins"
    );
}

/// O cartão do Cardigann: `div.posts > div.release`, com o `href` do título
/// apontando para o `/resolve` DO PRÓPRIO RESOLVER (é o que o Cardigann
/// copia para o `download.before`).
#[test]
fn cartao_tem_o_formato_do_cardigann() {
    let item = SearchItem {
        post: SitePost {
            title: "Batman Knightfall 2026 1080p".to_string(),
            url: "https://torrentgalaxy.one/post-detail/960407/x/".to_string(),
            poster: Some("https://i.rar.pics/009/ebe7c6c1fd443fa2f577.jpg".to_string()),
            date: Some("27/08/2026".to_string()),
            year: None,
            kind: Some("Movies".to_string()),
        },
        link: ResolverLink {
            url: "https://torrentgalaxy.one/post-detail/960407/x/".to_string(),
            size: Some("956.3 MB".to_string()),
            ..Default::default()
        },
        index: 0,
        count: 1,
        seeders: None,
        leechers: None,
    };
    let html = TORRENTGALAXY.search_page_html("http://127.0.0.1:8708", &[item]);
    assert!(html.contains("<div class=\"posts\">"), "falta div.posts");
    assert_eq!(html.matches("class=\"release\"").count(), 1);
    assert!(
        html.contains("<div class=\"title\"><a href=\"http://127.0.0.1:8708/resolve?url="),
        "o href do titulo tem que apontar para o /resolve do proprio resolver"
    );
    assert!(html.contains("&amp;i=0"), "falta o indice do botao");
    assert!(html.contains("<div class=\"size\">956.3 MB</div>"));
    assert!(html.contains("<div class=\"date\">27/08/2026</div>"));
    assert!(html.contains(
        "<div class=\"poster\"><img src=\"https://i.rar.pics/009/ebe7c6c1fd443fa2f577.jpg\""
    ));
    assert!(html.contains("<div class=\"description\">Movies</div>"));
}

/// O nome de cena chega ao Jackett COM os pontos: trocar por espaço
/// deformava "DDP5.1" em "DDP5 1" e "H.264" em "H 264". Só o `_` do slug sai.
#[test]
fn titulo_preserva_o_nome_de_cena() {
    assert_eq!(
        clean_title("Batman.Knightfall.2026.1080p.WEBRip.DDP5.1.H.264-NeoNoir"),
        "Batman.Knightfall.2026.1080p.WEBRip.DDP5.1.H.264-NeoNoir"
    );
    assert_eq!(
        clean_title("Show_Name &amp; Co  S01E02"),
        "Show Name & Co S01E02"
    );
}

/// Global P2P: a saúde publicada vai ao cartão (o Cardigann lê `div.seeders`).
/// `Some(0)` é torrent morto e TEM que sair como 0; sem dado, nenhuma div —
/// e o `default` do yml cobre.
#[test]
fn cartao_publica_os_seeders_do_site() {
    let item = |seeders: Option<u32>, leechers: Option<u32>| SearchItem {
        post: SitePost {
            title: "Batman 2026 1080p".to_string(),
            url: "https://torrentgalaxy.one/post-detail/1/x/".to_string(),
            poster: None,
            date: None,
            year: None,
            kind: None,
        },
        link: ResolverLink::default(),
        index: 0,
        count: 1,
        seeders,
        leechers,
    };
    let vivo =
        TORRENTGALAXY.search_page_html("http://127.0.0.1:8708", &[item(Some(1026), Some(168))]);
    assert!(vivo.contains("<div class=\"seeders\">1026</div>"));
    assert!(vivo.contains("<div class=\"leechers\">168</div>"));
    let morto = TORRENTGALAXY.search_page_html("http://127.0.0.1:8708", &[item(Some(0), Some(0))]);
    assert!(
        morto.contains("<div class=\"seeders\">0</div>"),
        "morto não vira 1"
    );
    let sem_dado = TORRENTGALAXY.search_page_html("http://127.0.0.1:8708", &[item(None, None)]);
    assert!(!sem_dado.contains("class=\"seeders\""));
}
