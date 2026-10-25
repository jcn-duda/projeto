use super::*;
use crate::listing::pagination::{ListingPageRead, ListingPost};
use crate::listing::{start_listing_cursor, ListingCursor};
use crate::sitemap::CrawlPageKind;

fn page(urls: &[&str]) -> ListingPageRead {
    ListingPageRead {
        posts: urls
            .iter()
            .map(|url| ListingPost {
                url: (*url).to_string(),
                kind: None,
            })
            .collect(),
        card_count: None,
        recognized_count: None,
        enqueued: None,
        end_of_listing: None,
    }
}

fn start(now: i64) -> ListingCursor {
    start_listing_cursor("hdrtorrent-cardigann", CrawlPageKind::Movie, "/pagina", now)
}

#[test]
fn carga_inicial_avanca_e_captura_o_head_da_pagina_1() {
    let cursor = start(1_000);
    let posts = [
        "/obra-nova-a",
        "/obra-nova-b",
        "/obra-nova-c",
        "/obra-nova-d",
    ];
    let result = read_listing_page(&cursor, &page(&posts), 2_000, 20, 0);
    assert!(result.advanced);
    assert!(!result.complete);
    assert_eq!(result.reason, ListingReadReason::Walk);
    assert_eq!(result.cursor.page, 2);
    assert_eq!(result.cursor.round_page, 1);
    assert_eq!(result.cursor.seen, 4);
    assert_eq!(result.cursor.updated_at, 2_000);
    assert_eq!(result.cursor.head.as_deref(), Some("/obra-nova-a"));
    assert_eq!(result.cursor.anchor, "", "carga inicial não move a âncora");
}

#[test]
fn teto_do_round_fecha_sem_cobertura_na_carga_inicial() {
    let mut cursor = start(1_000);
    cursor.page = 21;
    cursor.round_page = 19;
    let result = read_listing_page(&cursor, &page(&["/a", "/b"]), 2_000, 20, 0);
    assert!(result.advanced);
    assert!(!result.complete, "teto na carga inicial não é cobertura");
    assert_eq!(result.reason, ListingReadReason::RoundCap);
    assert_eq!(result.cursor.page, 22);
    assert_eq!(result.cursor.round_page, 0, "o round fechou");
    assert_eq!(result.cursor.rounds, 1);
    assert_eq!(
        result.cursor.anchor, "/b",
        "na carga inicial a âncora é o último post lido"
    );
}

#[test]
fn incremental_fecha_na_ancora_e_volta_para_a_pagina_1() {
    let mut cursor = start(1_000);
    cursor.sweep = true;
    cursor.anchor = "/obra-b".to_string();
    cursor.page = 3;
    cursor.round_page = 2;
    cursor.head = Some("/obra-c".to_string());
    let result = read_listing_page(&cursor, &page(&["/obra-c", "/obra-b"]), 2_000, 20, 0);
    assert!(result.advanced);
    assert!(result.complete);
    assert!(result.anchor_found);
    assert_eq!(result.reason, ListingReadReason::AnchorFound);
    assert_eq!(result.cursor.page, 1, "a passada seguinte começa no topo");
    assert!(result.cursor.sweep);
    assert_eq!(result.cursor.anchor, "/obra-c", "a âncora vira o head");
    assert_eq!(result.cursor.head, None, "head só vive durante a passada");
    assert_eq!(result.cursor.round_page, 0);
    assert_eq!(result.cursor.rounds, 1);
}

#[test]
fn incremental_sem_head_mantem_a_ancora_antiga_ao_fechar() {
    let mut cursor = start(1_000);
    cursor.sweep = true;
    cursor.anchor = "/velha".to_string();
    cursor.page = 2;
    cursor.head = None;
    let mut read = page(&["/x", "/y"]);
    read.end_of_listing = Some(true);
    let result = read_listing_page(&cursor, &read, 2_000, 20, 0);
    assert!(result.complete);
    assert_eq!(result.reason, ListingReadReason::EndOfListing);
    assert_eq!(result.cursor.page, 1);
    assert_eq!(
        result.cursor.anchor, "/velha",
        "sem head o marco anterior é preservado"
    );
}

#[test]
fn incremental_sem_ancora_no_teto_e_cobertura() {
    let mut cursor = start(1_000);
    cursor.sweep = true;
    cursor.anchor = String::new();
    cursor.round_page = 19;
    let result = read_listing_page(&cursor, &page(&["/a", "/b"]), 2_000, 20, 0);
    assert!(
        result.complete,
        "incremental sem âncora cobre relendo as páginas do topo"
    );
    assert_eq!(result.reason, ListingReadReason::RoundCap);
    assert_eq!(result.cursor.page, 1);
}

#[test]
fn round_esgotado_reinicia_sem_consumir_a_pagina() {
    let mut cursor = start(1_000);
    cursor.page = 9;
    cursor.seen = 100;
    cursor.round_page = 20;
    let result = read_listing_page(&cursor, &page(&["/a"]), 2_000, 20, 0);
    assert!(!result.advanced);
    assert!(!result.complete);
    assert_eq!(result.reason, ListingReadReason::RoundCap);
    assert_eq!(result.cursor.round_page, 0, "round reiniciado");
    assert_eq!(result.cursor.updated_at, 2_000);
    assert_eq!(result.cursor.page, 9, "posição intacta");
    assert_eq!(result.cursor.seen, 100, "orçamento intacto");
}

#[test]
fn teto_absoluto_de_profundidade_nao_consome() {
    let mut cursor = start(1_000);
    cursor.page = 5;
    let result = read_listing_page(&cursor, &page(&["/a"]), 2_000, 20, 4);
    assert!(!result.advanced);
    assert_eq!(result.reason, ListingReadReason::PageCap);
    assert_eq!(result.cursor, cursor, "nada consumido");
}

#[test]
fn fim_declarado_pelo_adaptador_fecha_a_rodada() {
    let mut read = page(&["/a", "/b"]);
    read.end_of_listing = Some(true);
    let result = read_listing_page(&start(1_000), &read, 2_000, 20, 0);
    assert!(result.complete);
    assert_eq!(result.reason, ListingReadReason::EndOfListing);
    assert_eq!(result.cursor.page, 1);
    assert!(
        result.cursor.sweep,
        "o fim da carga inicial vira incremental"
    );
    assert_eq!(result.cursor.head, None);
}

#[test]
fn post_sem_caminho_nao_vira_ancora() {
    let mut cursor = start(1_000);
    cursor.round_page = 19;
    let result = read_listing_page(&cursor, &page(&["", "/"]), 2_000, 20, 0);
    assert_eq!(
        result.cursor.anchor, "",
        "URL vazia e raiz não são marco de acervo"
    );
}

#[test]
fn orcamento_conta_posts_enfileirados_nao_a_pagina() {
    let mut read = page(&["/a", "/b"]);
    read.enqueued = Some(1);
    let result = read_listing_page(&start(1_000), &read, 2_000, 20, 0);
    assert_eq!(result.cursor.seen, 1);
}
