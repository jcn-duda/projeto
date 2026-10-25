//! Custo, cursores e a costura com a fila na descoberta do tick (fase 6).
//!
//! Relógio e rodízio estão em `discovery_tick_tests`; o harness compartilhado,
//! em `discovery_tick_test_support`. Aqui o que dói: a rodada cobra no MESMO
//! teto por hora das páginas, o cursor de data só anda com a completude DAQUELE
//! kind, o estado durável da LISTAGEM (`state_writes`) é lido antes e gravado
//! depois de a fila aceitar, e a descoberta roda ANTES de reivindicar.

use std::sync::Arc;

use crate::discovery::listing::listing_series_key;
use crate::discovery::{cursor_key, DiscoveryReport};
use crate::listing::cursor::listing_cursor_key;
use crate::motor::ingest::test_support::FakeIngest;
use crate::motor::r#loop::TickOutcome;
use crate::motor::types::{PageEngine, PageFuture, PageOutcome};
use crate::sitemap::CrawlPageKind;
use crate::store::ops::{CrawlStore, UrlRow};

use super::test_support::*;

// ─── Custo e cursores ───────────────────────────────────────────────────────

#[tokio::test]
async fn custo_da_rodada_entra_no_mesmo_teto_por_hora() {
    let (_dir, db) = db_temp();
    let fake = FakeDiscovery::new(vec![Ok(report_parcial())]);
    let motor = motor(&db, "http://127.0.0.1:1", fake);

    motor.discover_once().await.expect("rodada");
    assert_eq!(
        motor.status().await.pages_this_hour,
        3,
        "descoberta não é de graça: o teto é de requisições"
    );
}

#[tokio::test]
async fn cursor_so_avanca_com_o_kind_completo() {
    let (_dir, db) = db_temp();
    let fake = FakeDiscovery::new(vec![Ok(report_parcial())]);
    let motor = motor(&db, "http://127.0.0.1:1", fake);

    let tick = motor.discover_once().await.expect("rodada");
    assert_eq!((tick.urls, tick.added, tick.cost), (2, 2, 3));
    assert!(tick.partial, "houve falha parcial");

    let store = CrawlStore::open(&db).expect("abrir para ler");
    let movie = store.get_state(&tick.site, cursor_key(CrawlPageKind::Movie));
    assert_eq!(
        movie.expect("cursor de filme").as_deref(),
        Some("2026-10-01T00:00:00Z"),
        "filme completo move o cursor"
    );
    let tv = store.get_state(&tick.site, cursor_key(CrawlPageKind::TvShow));
    assert_eq!(
        tv.expect("consulta"),
        None,
        "série parcial NÃO move o cursor"
    );
}

#[tokio::test]
async fn cursor_legado_migra_para_movie_e_vira_corte() {
    let (_dir, db) = db_temp();
    {
        let store = CrawlStore::open(&db).expect("abrir");
        store.migrate().expect("migrar");
        store
            .set_state(PRIMEIRO, "cursor", "2026-01-01T00:00:00Z")
            .expect("cursor legado");
    }
    let fake = FakeDiscovery::new(Vec::new());
    let motor = motor(&db, "http://127.0.0.1:1", fake.clone());

    motor.discover_once().await.expect("rodada");
    let call = fake.calls().remove(0);
    assert_eq!(
        call.opts.since_movie.as_deref(),
        Some("2026-01-01T00:00:00Z"),
        "o cursor legado é o corte do filme"
    );
    assert_eq!(call.opts.since_tv_show, None);

    let store = CrawlStore::open(&db).expect("abrir para ler");
    let migrado = store.get_state(PRIMEIRO, cursor_key(CrawlPageKind::Movie));
    assert_eq!(
        migrado.expect("cursor migrado").as_deref(),
        Some("2026-01-01T00:00:00Z"),
        "a migração grava cursor:movie uma vez"
    );
}

#[tokio::test]
async fn estado_duravel_da_trilha_e_lido_antes_e_gravado_depois() {
    // O cursor da LISTAGEM não cabe em `next_cursor`: ele corta por posição e
    // âncora, não por data. Viaja em `state_writes`, e quem lê e grava é o
    // motor — de propósito: gravar antes do `enqueue` avança por cima de
    // descoberta que nunca entrou na fila.
    let (_dir, db) = db_temp();
    let cursor = listing_cursor_key(CrawlPageKind::Movie, "/pagina/");
    let marcador = listing_series_key(CrawlPageKind::Movie, "/pagina/");
    {
        let store = CrawlStore::open(&db).expect("abrir");
        store.migrate().expect("migrar");
        store
            .set_state(PRIMEIRO, &cursor, "lc1.da-rodada-anterior")
            .expect("cursor semeado");
        store
            .set_state(PRIMEIRO, &marcador, "0:r2")
            .expect("marcador semeado");
    }
    let fake = FakeDiscovery::reading(
        vec![Ok(DiscoveryReport {
            urls: vec![discovered(
                "/a/",
                "2026-10-02T00:00:00Z",
                CrawlPageKind::Movie,
            )],
            complete: true,
            complete_movie: true,
            complete_tv_show: false,
            failures: Vec::new(),
            request_cost: 2,
            // Ordem da trilha: marcador ANTES do cursor.
            state_writes: vec![
                (marcador.clone(), "1:r2".to_string()),
                (cursor.clone(), "lc1.da-rodada-atual".to_string()),
            ],
        })],
        vec![cursor.clone(), marcador.clone()],
    );
    let motor = motor(&db, "http://127.0.0.1:1", fake.clone());

    let tick = motor.discover_once().await.expect("rodada");
    assert_eq!(tick.site, PRIMEIRO);

    let call = fake.calls().remove(0);
    assert_eq!(
        call.opts.site_state,
        vec![
            (cursor.clone(), "lc1.da-rodada-anterior".to_string()),
            (marcador.clone(), "0:r2".to_string()),
        ],
        "o motor lê as chaves declaradas pela trilha, na ordem dela"
    );
    assert!(
        call.opts.now > 0,
        "a rodada leva o relógio: o cursor de listagem carimba a hora"
    );
    assert_eq!(
        call.opts.listing_round_max_pages,
        crate::listing::cursor::LISTING_ROUND_MAX_PAGES,
        "o teto de páginas da listagem vem da config do motor"
    );

    let store = CrawlStore::open(&db).expect("abrir para ler");
    assert_eq!(
        store.get_state(PRIMEIRO, &cursor).expect("consulta"),
        Some("lc1.da-rodada-atual".to_string()),
        "o cursor novo chegou ao `crawl_state`"
    );
    assert_eq!(
        store.get_state(PRIMEIRO, &marcador).expect("consulta"),
        Some("1:r2".to_string()),
        "o marcador do portão também"
    );
}

// ─── A costura dentro do tick ───────────────────────────────────────────────

/// Engine que sempre falha: só prova que a fila FOI alimentada pela descoberta.
struct EngineFalha;

impl PageEngine for EngineFalha {
    fn is_ready(&self) -> bool {
        true
    }

    fn execute<'a>(&'a self, _row: &'a UrlRow) -> PageFuture<'a> {
        Box::pin(async { PageOutcome::Failed("sem parser no teste".into()) })
    }
}

#[tokio::test]
async fn tick_descobre_antes_de_reivindicar() {
    let (_dir, db) = db_temp();
    let node = node(false).await;
    let fake = FakeDiscovery::new(vec![Ok(report_parcial())]);
    let motor = motor(&db, &node, fake.clone())
        .with_page_engine(Arc::new(EngineFalha))
        .with_ingest(Arc::new(FakeIngest::delivered()));

    match motor.tick_once().await.expect("tick") {
        TickOutcome::Processed { claimed, .. } => {
            assert_eq!(claimed, 1, "a fila veio da descoberta, não estava vazia");
        }
        outro => panic!("esperava lote: {outro:?}"),
    }
    assert_eq!(fake.calls().len(), 1, "a descoberta rodou dentro do tick");
}
