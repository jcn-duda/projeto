use std::collections::HashMap;
use std::sync::Mutex;

use super::*;
use crate::listing::pagination::{ListingPageRead, ListingPost};
use crate::listing::{start_listing_cursor, ListingCursor};
use crate::sitemap::CrawlPageKind;

/// Dublê do site: páginas por número e o registro dos acessos.
struct Fake {
    pages: HashMap<u32, Result<ListingPageRead, String>>,
    hits: Mutex<Vec<u32>>,
}

impl Fake {
    fn new(pages: &[(u32, Result<ListingPageRead, String>)]) -> Self {
        Self {
            pages: pages.iter().cloned().collect(),
            hits: Mutex::new(Vec::new()),
        }
    }

    fn hits(&self) -> Vec<u32> {
        self.hits.lock().unwrap().clone()
    }
}

impl ListingPageReader for Fake {
    fn read_page<'a>(&'a self, page: u32) -> ListingPageFuture<'a> {
        Box::pin(async move {
            self.hits.lock().unwrap().push(page);
            match self.pages.get(&page) {
                Some(Ok(read)) => Ok(read.clone()),
                Some(Err(err)) => Err(err.clone()),
                None => Err("HTTP 404".to_string()),
            }
        })
    }
}

fn page(posts: &[(&str, Option<CardKind>)], cards: Option<usize>) -> ListingPageRead {
    ListingPageRead {
        posts: posts
            .iter()
            .map(|(url, kind)| ListingPost {
                url: (*url).to_string(),
                kind: *kind,
            })
            .collect(),
        card_count: cards,
        recognized_count: cards,
        enqueued: None,
        end_of_listing: None,
    }
}

fn simple(urls: &[&str]) -> ListingPageRead {
    let posts: Vec<(&str, Option<CardKind>)> = urls.iter().map(|u| (*u, None)).collect();
    page(&posts, Some(urls.len()))
}

/// Página CHEIA (`expected_per_page` posts), com URLs únicas por prefixo.
fn full(prefix: &str) -> ListingPageRead {
    let urls: Vec<String> = (0..20).map(|i| format!("/{prefix}-{i}")).collect();
    let refs: Vec<&str> = urls.iter().map(String::as_str).collect();
    simple(&refs)
}

fn start() -> ListingCursor {
    start_listing_cursor(
        "hdrtorrent-cardigann",
        CrawlPageKind::Movie,
        "/pagina",
        1_000,
    )
}

fn input<'a>(reader: &'a dyn ListingPageReader, cursor: ListingCursor) -> ListingWalkInput<'a> {
    ListingWalkInput {
        reader,
        expected_per_page: 20,
        round_max_pages: 20,
        series_enabled: true,
        default_kind: CrawlPageKind::Movie,
        cursor,
        now: 2_000,
    }
}

#[tokio::test]
async fn anda_ate_a_pagina_calcanhar_e_fecha_completa() {
    let fake = Fake::new(&[
        (1, Ok(full("a"))),
        (2, Ok(full("b"))),
        (
            3,
            Ok(simple(&[
                "/c-1", "/c-2", "/c-3", "/c-4", "/c-5", "/c-6", "/c-7", "/c-8", "/c-9", "/c-10",
                "/c-11", "/c-12", "/c-13", "/c-14", "/c-15",
            ])),
        ),
    ]);
    let out = walk_listing(input(&fake, start())).await;
    assert_eq!(out.requests, 3);
    assert_eq!(out.pages_consumed, 3);
    assert_eq!(out.urls.len(), 55);
    assert!(out.complete, "fim de catálogo por contagem cobre o acervo");
    assert!(out.end_of_listing);
    assert_eq!(out.reason, "end-of-listing");
    assert!(out.cursor.sweep, "a carga inicial vira incremental");
    assert_eq!(out.cursor.page, 1);
    assert_eq!(fake.hits(), vec![1, 2, 3]);
}

#[tokio::test]
async fn pagina_sem_card_e_falha_e_nao_consome_o_cursor() {
    let fake = Fake::new(&[(1, Ok(page(&[], Some(0))))]);
    let out = walk_listing(input(&fake, start())).await;
    assert_eq!(out.failures, vec!["listing-pagina-1:nenhum-card"]);
    assert!(!out.complete, "lista vazia nunca é 'vazio e completo'");
    assert_eq!(out.pages_consumed, 0);
    assert_eq!(out.requests, 1, "o request saiu e queima orçamento");
    assert_eq!(out.cursor.page, 1, "o retry relê a MESMA página");
    assert_eq!(out.cursor.seen, 0);
}

#[tokio::test]
async fn cards_reconhecidos_fora_do_host_sao_falha() {
    let fake = Fake::new(&[(1, Ok(page(&[], Some(5))))]);
    let out = walk_listing(input(&fake, start())).await;
    assert_eq!(out.failures, vec!["listing-pagina-1:nenhuma-obra-no-host"]);
    assert!(!out.complete);
}

#[tokio::test]
async fn cards_nao_reconhecidos_sao_falha() {
    let read = ListingPageRead {
        posts: Vec::new(),
        card_count: Some(3),
        recognized_count: Some(0),
        enqueued: None,
        end_of_listing: None,
    };
    let fake = Fake::new(&[(1, Ok(read))]);
    let out = walk_listing(input(&fake, start())).await;
    assert_eq!(
        out.failures,
        vec!["listing-pagina-1:cards-nao-reconhecidos"]
    );
}

#[tokio::test]
async fn carga_inicial_nao_fecha_na_ancora() {
    let mut cursor = start();
    cursor.anchor = "/obra-b".to_string();
    // Página CHEIA com a âncora dentro: só a falta do fim por contagem impede
    // o fecho, então o que está sob teste é o `sweep == false`.
    let urls: Vec<String> = std::iter::once("/obra-b".to_string())
        .chain((0..19).map(|i| format!("/nova-{i}")))
        .collect();
    let refs: Vec<&str> = urls.iter().map(String::as_str).collect();
    let fake = Fake::new(&[(1, Ok(simple(&refs)))]);
    let out = walk_listing(input(&fake, cursor)).await;
    assert!(
        !out.complete,
        "na carga inicial a âncora não prova cobertura"
    );
    assert!(!out.cursor.sweep, "nada fechou o round");
    assert_eq!(fake.hits(), vec![1, 2], "segue andando até o fim");
}

#[tokio::test]
async fn incremental_fecha_na_ancora_e_emite_so_as_novas() {
    let mut cursor = start();
    cursor.sweep = true;
    cursor.anchor = "/obra-b".to_string();
    cursor.head = Some("/obra-nova".to_string());
    let fake = Fake::new(&[(1, Ok(simple(&["/obra-nova", "/obra-b", "/obra-antiga"])))]);
    let out = walk_listing(input(&fake, cursor)).await;
    assert!(out.complete);
    assert!(out.end_of_listing);
    assert_eq!(out.reason, "anchor-found");
    assert_eq!(out.urls.len(), 3, "a página inteira é emitida");
    assert_eq!(out.cursor.page, 1);
    assert_eq!(out.cursor.anchor, "/obra-nova");
}

#[tokio::test]
async fn serie_desligada_nao_emite_mas_consome_a_pagina() {
    let fake = Fake::new(&[(
        1,
        Ok(page(
            &[
                ("/serie-1", Some(CardKind::TvShow)),
                ("/filme-1", Some(CardKind::Movie)),
            ],
            Some(2),
        )),
    )]);
    let mut walk = input(&fake, start());
    walk.series_enabled = false;
    let out = walk_listing(walk).await;
    assert_eq!(out.urls.len(), 1);
    assert_eq!(out.urls[0].url, "/filme-1");
    assert_eq!(out.pages_consumed, 1, "o orçamento do site foi gasto");
}

#[tokio::test]
async fn pagina_cheia_repetida_fecha_sem_cobertura() {
    let fake = Fake::new(&[(1, Ok(full("a"))), (2, Ok(full("a")))]);
    let out = walk_listing(input(&fake, start())).await;
    assert_eq!(out.urls.len(), 20, "os repetidos não entram duas vezes");
    assert_eq!(out.pages_consumed, 2);
    assert_eq!(out.reason, "already-seen-page");
    assert!(!out.complete, "inversão de página não prova fim de acervo");
}

#[tokio::test]
async fn erro_de_rede_vira_falha_e_fecha_a_rodada() {
    let fake = Fake::new(&[
        (1, Ok(full("a"))),
        (2, Err("HTTP 500  servidor".to_string())),
    ]);
    let out = walk_listing(input(&fake, start())).await;
    assert_eq!(out.requests, 2);
    assert_eq!(out.pages_consumed, 1);
    assert_eq!(out.failures, vec!["listing-pagina-2:HTTP-500-servidor"]);
    assert!(!out.complete);
}

#[tokio::test]
async fn teto_de_rodada_para_sem_afirmar_cobertura() {
    let fake = Fake::new(&[(1, Ok(full("a"))), (2, Ok(full("b"))), (3, Ok(full("c")))]);
    let mut walk = input(&fake, start());
    walk.round_max_pages = 2;
    let out = walk_listing(walk).await;
    assert_eq!(out.pages_consumed, 2);
    assert_eq!(out.reason, "round-cap");
    assert!(!out.complete);
    assert_eq!(out.requests, 2, "o teto também poupa requisição");
}

#[tokio::test]
async fn lastmod_sai_vazio_e_o_kind_vem_do_card_ou_do_default() {
    let fake = Fake::new(&[(
        1,
        Ok(page(
            &[("/sem-kind", None), ("/serie", Some(CardKind::TvShow))],
            Some(2),
        )),
    )]);
    let mut walk = input(&fake, start());
    walk.default_kind = CrawlPageKind::TvShow;
    let out = walk_listing(walk).await;
    assert_eq!(out.urls.len(), 2);
    assert!(out.urls.iter().all(|u| u.lastmod.is_empty()));
    assert_eq!(out.urls[0].kind, CrawlPageKind::TvShow);
    assert_eq!(out.urls[1].kind, CrawlPageKind::TvShow);
}

#[test]
fn motivo_de_erro_e_curto_e_sem_espaco() {
    assert_eq!(reason_of("  boom   500  "), "boom-500");
    assert_eq!(reason_of(""), "erro");
    let longo = "x".repeat(200);
    assert_eq!(reason_of(&longo).chars().count(), 80);
}
