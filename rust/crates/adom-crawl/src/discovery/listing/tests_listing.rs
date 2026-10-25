//! Testes da descoberta por LISTAGEM (fase 6, trilha de listing).
//!
//! Duas metades: as regras puras (tabela de sites, URL da página, portão de
//! séries) e a RODADA de ponta a ponta com o HTML REAL dos dois sites, provando
//! o que a fiação promete — cursor gravado só com a página consumida, marcador
//! antes do cursor, séries desligadas descartando sem afirmar cobertura, e
//! página sem card reconhecido virando FALHA (nunca vazio completo).

use super::*;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::discovery::fetch::{SitemapFetch, SitemapFuture};
use crate::discovery::{discoverable_sites, listing_config, listing_sites};
use crate::listing::cursor::{
    decode_listing_cursor, encode_listing_cursor, listing_cursor_key, start_listing_cursor,
    ListingCursor,
};
use crate::sitemap::CrawlPageKind;

const HDR_PAGE1: &str =
    include_str!("../../../../../../test/fixtures/crawl/hdrtorrents/pagina-1-cheia.html");
const APACHE_PAGE1: &str =
    include_str!("../../../../../../test/fixtures/crawl/apachetorrent/pagina-1-cheia.html");
const APACHE_PAGE_END: &str =
    include_str!("../../../../../../test/fixtures/crawl/apachetorrent/pagina-fim-calcanhar.html");

const HDR: &str = "hdrtorrent-cardigann";
const APACHE: &str = "apachetorrent-cardigann";
const NOW: i64 = 1_700_000_000_000;

/// DNS falso: serve os corpos por URL e registra cada pedido.
struct FakeFetch {
    pages: HashMap<String, String>,
    hits: Mutex<Vec<String>>,
}

impl FakeFetch {
    fn new(pages: &[(&str, &str)]) -> Arc<Self> {
        Arc::new(Self {
            pages: pages
                .iter()
                .map(|(url, body)| (url.to_string(), body.to_string()))
                .collect(),
            hits: Mutex::new(Vec::new()),
        })
    }

    fn hits(&self) -> Vec<String> {
        self.hits.lock().map(|h| h.clone()).unwrap_or_default()
    }
}

impl SitemapFetch for FakeFetch {
    fn fetch<'a>(&'a self, _site: &'a str, url: &'a str) -> SitemapFuture<'a> {
        Box::pin(async move {
            if let Ok(mut hits) = self.hits.lock() {
                hits.push(url.to_string());
            }
            self.pages
                .get(url)
                .cloned()
                .ok_or_else(|| "HTTP 404".to_string())
        })
    }
}

fn discovery(fake: &Arc<FakeFetch>) -> ListingDiscovery {
    ListingDiscovery::new(fake.clone(), Duration::from_secs(5))
}

fn opts(emit_series: bool) -> DiscoveryOptions {
    DiscoveryOptions {
        emit_series,
        now: NOW,
        ..Default::default()
    }
}

fn keys() -> (String, String) {
    (
        listing_cursor_key(CrawlPageKind::Movie, "/pagina/"),
        listing_series_key(CrawlPageKind::Movie, "/pagina/"),
    )
}

// ─── Tabela e URL da página ─────────────────────────────────────────────────

#[test]
fn tabela_fecha_os_dois_sites_de_listagem() {
    assert_eq!(listing_sites(), vec![HDR, APACHE]);
    for site in listing_sites() {
        let cfg = listing_config(site).expect("site da lista tem config");
        assert_eq!(cfg.site_id, site);
        assert_eq!(cfg.page_path, "/pagina/", "caminho medido nos dois sites");
        assert_eq!(cfg.cards_per_page, 20, "página cheia medida");
    }
    assert!(listing_config("vacatorrent").is_none());
}

#[test]
fn lista_do_motor_soma_as_duas_trilhas() {
    let sites = discoverable_sites();
    assert_eq!(sites.len(), 8, "seis de sitemap + dois de listagem");
    assert!(sites.contains(&HDR));
    assert!(sites.contains(&APACHE));
    assert!(sites.contains(&"vacatorrent"));
    assert!(
        !sites.contains(&"mico"),
        "o Mico tem lane própria, fora do rodízio"
    );
}

#[test]
fn url_da_pagina_um_e_a_raiz() {
    assert_eq!(
        page_url("https://hdrtorrents.net", "/pagina/", 1),
        "https://hdrtorrents.net/"
    );
    assert_eq!(
        page_url("https://apachetorrents.com/", "/pagina/", 2),
        "https://apachetorrents.com/pagina/2/"
    );
    assert_eq!(
        page_url("https://apachetorrents.com", "/pagina/", 2123),
        "https://apachetorrents.com/pagina/2123/"
    );
}

// ─── Portão de séries ───────────────────────────────────────────────────────

fn cursor(page: u32, sweep: bool) -> ListingCursor {
    let mut c = start_listing_cursor("site", CrawlPageKind::Movie, "/pagina/", NOW);
    c.page = page;
    c.sweep = sweep;
    c
}

#[test]
fn portao_igual_mantem_o_cursor() {
    let saved = marker_of(true);
    let gate = load_with_gate(Some(cursor(7, false)), Some(&saved), true);
    assert_eq!(gate.cursor.map(|c| c.page), Some(7));
    assert!(!gate.clear);
}

#[test]
fn portao_invertido_descarta_o_cursor() {
    // Varredura feita com séries DESLIGADAS e agora ligadas: as páginas atrás
    // do marco tiveram as URLs de série jogadas fora. Reler é o único conserto.
    let gate = load_with_gate(Some(cursor(9, true)), Some(&marker_of(false)), true);
    assert!(gate.cursor.is_none());
    assert!(gate.clear, "o cursor velho tem que ser apagado");

    let gate = load_with_gate(Some(cursor(9, true)), Some(&marker_of(true)), false);
    assert!(gate.clear);
}

#[test]
fn regra_antiga_em_carga_segue_de_onde_esta() {
    // Marcador só com o bit (r1) e o MESMO portão: a carga não declarou
    // cobertura, então continuar de onde está é seguro.
    let gate = load_with_gate(Some(cursor(543, false)), Some("1"), true);
    assert_eq!(gate.cursor.map(|c| c.page), Some(543));
    assert!(!gate.clear);

    // Já virou incremental: pode ter parado num fim falso (o Apache parou na
    // 211 de 2123) e a carga é refeita.
    let gate = load_with_gate(Some(cursor(211, true)), Some("1"), true);
    assert!(gate.cursor.is_none());
    assert!(gate.clear);
}

#[test]
fn marcador_ausente_descarta_uma_vez() {
    let gate = load_with_gate(Some(cursor(3, false)), None, true);
    assert!(gate.clear);
    assert!(gate.cursor.is_none());
    // Sem cursor não há o que comparar: nada a apagar.
    let gate = load_with_gate(None, None, true);
    assert!(!gate.clear);
}

// ─── Rodada de ponta a ponta ────────────────────────────────────────────────

#[tokio::test]
async fn hdr_anda_duas_paginas_e_grava_marcador_antes_do_cursor() {
    // A mesma página cheia nas duas posições: os 20 posts já foram vistos, o
    // que fecha o round por INVERSÃO (sem afirmar cobertura).
    let fake = FakeFetch::new(&[
        ("https://hdrtorrents.net/", HDR_PAGE1),
        ("https://hdrtorrents.net/pagina/2/", HDR_PAGE1),
    ]);
    let report = discovery(&fake)
        .discover(HDR, &opts(true))
        .await
        .expect("rodada completa");

    assert_eq!(
        report.urls.len(),
        20,
        "11 filmes + 9 séries na página mista"
    );
    assert_eq!(report.request_cost, 2);
    assert!(!report.complete, "inversão de página não é cobertura");
    assert!(report.failures.is_empty());

    let (cursor_key, marker_key) = keys();
    let writes = &report.state_writes;
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].0, marker_key);
    assert_eq!(writes[0].1, marker_of(true));
    assert_eq!(writes[1].0, cursor_key);

    let cursor = decode_listing_cursor(&writes[1].1).expect("token durável");
    assert_eq!(cursor.page, 3, "a próxima rodada continua da página 3");
    assert_eq!(cursor.seen, 40, "as duas páginas foram contadas");
    assert!(!cursor.sweep, "a carga inicial ainda não acabou");
}

#[tokio::test]
async fn apache_series_desligadas_descarta_sem_afirmar_cobertura() {
    let fake = FakeFetch::new(&[
        ("https://apachetorrents.com/", APACHE_PAGE1),
        ("https://apachetorrents.com/pagina/2/", APACHE_PAGE_END),
    ]);
    let report = discovery(&fake)
        .discover(APACHE, &opts(false))
        .await
        .expect("rodada completa");

    assert_eq!(
        report.urls.len(),
        16,
        "11 filmes da página cheia + 5 da calcanhar (as séries foram descartadas)"
    );
    assert!(
        report.urls.iter().all(|u| u.kind == CrawlPageKind::Movie),
        "nenhuma URL de série entra na fila"
    );
    // A página calcanhar (15 cards) declarou o fim: a cobertura do que foi
    // EMITIDO é real.
    assert!(report.complete);
    assert!(report.complete_movie);
    assert!(
        !report.complete_tv_show,
        "as séries foram lidas e descartadas: `true` afirmaria cobertura inexistente"
    );
    assert_eq!(report.request_cost, 2);
    assert_eq!(
        report.state_writes[0].1,
        marker_of(false),
        "o marcador denuncia que a varredura descartou série"
    );
}

#[tokio::test]
async fn pagina_sem_card_reconhecido_e_falha_nunca_vazio_completo() {
    let fake = FakeFetch::new(&[(
        "https://hdrtorrents.net/",
        "<html><body>vazio</body></html>",
    )]);
    let report = discovery(&fake)
        .discover(HDR, &opts(true))
        .await
        .expect("rodada não é erro de fonte");

    assert!(report.urls.is_empty());
    assert!(
        !report.complete,
        "`urls: []` com `complete: true` faria o cursor avançar sobre acervo nunca lido"
    );
    assert_eq!(report.failures.len(), 1);
    assert!(
        report.failures[0].contains("nenhum-card"),
        "{:?}",
        report.failures
    );
    assert!(
        report.state_writes.is_empty(),
        "nenhuma página consumida, nenhum cursor a gravar"
    );
}

#[tokio::test]
async fn porta_invertido_recomeca_da_pagina_1() {
    let mut velho = start_listing_cursor(HDR, CrawlPageKind::Movie, "/pagina/", NOW);
    velho.page = 7;
    velho.sweep = true;
    let (cursor_key, marker_key) = keys();
    let mut o = opts(true);
    o.site_state = vec![
        (cursor_key.clone(), encode_listing_cursor(&velho)),
        (marker_key, marker_of(false)),
    ];

    let fake = FakeFetch::new(&[("https://hdrtorrents.net/", HDR_PAGE1)]);
    let report = discovery(&fake)
        .discover(HDR, &o)
        .await
        .expect("rodada completa");

    assert_eq!(
        fake.hits().first().map(String::as_str),
        Some("https://hdrtorrents.net/"),
        "a varredura volta para a página 1"
    );
    assert_eq!(
        report.state_writes[0],
        (cursor_key, String::new()),
        "o cursor incompatível é apagado ANTES de qualquer gravação nova"
    );
}

#[tokio::test]
async fn host_fora_do_ar_faz_failover_para_o_candidato() {
    // O perfil do Apache lista `apachetorrents.com` antes do `.com` alternativo;
    // só o segundo responde aqui.
    let fake = FakeFetch::new(&[
        ("https://apachetorrent.com/", APACHE_PAGE1),
        ("https://apachetorrent.com/pagina/2/", APACHE_PAGE_END),
    ]);
    let report = discovery(&fake)
        .discover(APACHE, &opts(false))
        .await
        .expect("rodada completa");

    assert!(!report.urls.is_empty());
    let hits = fake.hits();
    // Host morto: uma tentativa por página 1 (antes de memoizar o ativo), e a
    // página 2 já vai direto ao candidato que respondeu.
    assert_eq!(
        hits.iter()
            .filter(|u| u.contains("apachetorrents.com"))
            .count(),
        1,
        "o host ativo é memoizado: {hits:?}"
    );
    assert_eq!(
        hits.last().map(String::as_str),
        Some("https://apachetorrent.com/pagina/2/")
    );
}
