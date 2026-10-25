//! Testes da ingestão nativa (T3-L3): as três escritas do recorder e a
//! identificação por página, com store em memória e catálogo stub (sem rede).

use adom_core::WorkTarget;
use adom_search::RawItem;

use super::tests_harness::{IngestHarness, StubCatalog};
use super::{parse_size_bytes, raw_item, IngestError, PageMark};
use crate::motor::types::{CrawlRawItem, CrawlReleaseGroup, CrawlResultStatus, CrawlWorkResult};
use crate::season_page::{season_page_groups as group_season_page, SeasonPageInfo};
use crate::vaca_series::{CrawlReleaseGroup as SeriesGroup, CrawlReleaseItem};

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccc";
const HASH_D: &str = "dddddddddddddddddddddddddddddddddddddddd";

const ROOT: WorkTarget = WorkTarget {
    season: None,
    episode: None,
};

// ── Fixtures (o que o motor entrega por página) ──────────────────────────────

fn release(title: &str, hash: &str, is_br: bool) -> CrawlRawItem {
    CrawlRawItem {
        title: title.to_string(),
        magnet: Some(format!(
            "magnet:?xt=urn:btih:{hash}&dn={}",
            title.replace(' ', ".")
        )),
        link: None,
        size: Some("1.5 GB".to_string()),
        seeders: Some(3),
        tracker: Some("BLUDV".to_string()),
        is_br,
    }
}

fn pagina_de_serie() -> CrawlWorkResult {
    CrawlWorkResult {
        url: "https://nerdfilmes.com/serie-teste-1a-temporada/".to_string(),
        url_key: "serie-teste-1a-temporada".to_string(),
        site: "nerdfilmes".to_string(),
        status: CrawlResultStatus::Done,
        imdb: None,
        title: Some("Serie Teste".to_string()),
        year: Some(202),
        kind: "series".to_string(),
        releases: vec![
            release("Serie Teste S01E01 1080p DUBLADO", HASH_A, true),
            release("Serie Teste S01E02 1080p DUBLADO", HASH_B, true),
        ],
        groups: Vec::new(),
        unlocated: Vec::new(),
        progress: None,
        request_cost: 1,
        error: String::new(),
        gate: None,
    }
}

fn pagina_de_filme() -> CrawlWorkResult {
    CrawlWorkResult {
        url: "https://hdr.com/filme-teste-2024/".to_string(),
        url_key: "filme-teste-2024".to_string(),
        site: "hdr".to_string(),
        status: CrawlResultStatus::Done,
        imdb: Some("tt777".to_string()),
        title: Some("Filme Teste".to_string()),
        year: Some(2024),
        kind: "movie".to_string(),
        releases: vec![release("Filme Teste 2024 1080p DUBLADO", HASH_C, true)],
        groups: Vec::new(),
        unlocated: Vec::new(),
        progress: None,
        request_cost: 1,
        error: String::new(),
        gate: None,
    }
}

fn pagina_sem_imdb() -> CrawlWorkResult {
    CrawlWorkResult {
        url: "https://bludv.com/duna-2021/".to_string(),
        url_key: "duna-2021".to_string(),
        site: "bludv".to_string(),
        status: CrawlResultStatus::Done,
        imdb: None,
        title: Some("Duna".to_string()),
        year: Some(2021),
        kind: "movie".to_string(),
        releases: vec![release("Duna 2021 1080p DUBLADO", HASH_D, true)],
        groups: Vec::new(),
        unlocated: Vec::new(),
        progress: None,
        request_cost: 1,
        error: String::new(),
        gate: None,
    }
}

/// Release do agrupamento real de página de temporada (o mesmo que o motor
/// usa): o `dn=` mais específico manda na locação.
#[derive(Clone)]
struct RawRelease(CrawlRawItem);

impl CrawlReleaseItem for RawRelease {
    fn title(&self) -> &str {
        &self.0.title
    }

    fn magnet_display_name(&self) -> String {
        adom_core::magnet_display_name(self.0.magnet.as_deref(), None, None)
    }
}

/// Página de temporada como o motor a entrega: `groups` por episódio.
fn season_page_groups(page: &CrawlWorkResult) -> Vec<CrawlWorkResult> {
    let releases: Vec<RawRelease> = page.releases.iter().cloned().map(RawRelease).collect();
    let groups = group_season_page(
        &releases,
        &SeasonPageInfo {
            season: Some(1),
            title: "Serie Teste",
        },
    );
    let groups: Vec<CrawlReleaseGroup> = groups
        .into_iter()
        .map(|group: SeriesGroup<RawRelease>| CrawlReleaseGroup {
            season: group.season.and_then(|season| u32::try_from(season).ok()),
            episode: group
                .episode
                .and_then(|episode| u32::try_from(episode).ok()),
            releases: group.releases.into_iter().map(|rel| rel.0).collect(),
        })
        .collect();
    vec![CrawlWorkResult {
        releases: Vec::new(),
        groups,
        ..page.clone()
    }]
}

// ── Testes ──────────────────────────────────────────────────────────────────

/// S01E01 e S01E02 no mesmo post: UMA gravação por locação, duas linhas de
/// índice e UMA invalidação da obra (não uma por episódio).
#[tokio::test]
async fn grupo_de_serie_grava_uma_vez_por_locacao() {
    let harness = IngestHarness::new().with_catalog(StubCatalog::series(202, "tt555"));
    let pages = season_page_groups(&pagina_de_serie());
    assert_eq!(pages[0].groups.len(), 2, "S01E01 e S01E02");

    let out = harness.apply("nerdfilmes", &pages, 1_000).await.unwrap();
    assert_eq!(out.works, 1);
    assert_eq!(out.releases, 2, "S01E01 e S01E02");
    assert_eq!(out.index_rows, 2);
    assert_eq!(
        harness.index().count_live(1_000).unwrap(),
        2,
        "duas linhas de índice (uma por locação)"
    );
    assert_eq!(
        harness.invalidations(),
        vec!["tt555".to_string()],
        "uma invalidação por obra"
    );
}

/// Página sem IMDb: o veredito do catálogo decide. Ambíguo é TERMINAL (obra
/// errada é pior que nenhuma) e nada é escrito.
#[tokio::test]
async fn pagina_sem_imdb_identifica_e_marca_no_work_quando_ambiguo() {
    let harness = IngestHarness::new().with_catalog(StubCatalog::ambiguous("Duna"));
    let out = harness
        .apply("bludv", &[pagina_sem_imdb()], 1_000)
        .await
        .unwrap();
    assert_eq!(out.works, 0);
    assert_eq!(out.mark, Some(PageMark::Ambiguous));
    assert!(!out.retryable, "ambíguo é terminal");
    assert!(harness.invalidations().is_empty());
    assert_eq!(harness.index().count_live(1_000).unwrap(), 0);
    assert!(
        harness
            .catalog_calls()
            .iter()
            .any(|call| call == "identify:movie:Duna"),
        "a página sem IMDb consultou a identificação"
    );
}

/// A mesma página aplicada duas vezes: a primeira transição (sem BR → BR)
/// invalida; a segunda não muda nada e não invalida de novo.
#[tokio::test]
async fn gravacao_do_indice_invalida_a_obra_uma_unica_vez() {
    let harness = IngestHarness::new().with_catalog(StubCatalog::movie("tt777"));
    harness
        .apply("hdr", &[pagina_de_filme()], 1_000)
        .await
        .unwrap();
    harness
        .apply("hdr", &[pagina_de_filme()], 2_000)
        .await
        .unwrap();
    assert_eq!(harness.invalidations(), vec!["tt777".to_string()]);
    assert_eq!(harness.lookup("tt777", ROOT, 2_000).len(), 1);
}

/// `partial`/`keepPartial`: chave nova nasce parcial (a raspagem cobre UMA
/// página); chave que já era completa continua completa (nunca rebaixa).
#[tokio::test]
async fn pagina_parcial_marca_a_chave_e_preserva_completude() {
    let harness = IngestHarness::new().with_catalog(StubCatalog::movie("tt777"));
    harness
        .apply("hdr", &[pagina_de_filme()], 1_000)
        .await
        .unwrap();
    assert!(
        harness.is_partial("tt777", ROOT, 1_000),
        "chave nova nasce parcial"
    );

    let harness = IngestHarness::new().with_catalog(StubCatalog::movie("tt777"));
    let seed = raw_item(
        "hdr",
        &release("Filme Teste 2024 1080p DUBLADO", HASH_D, true),
    );
    harness.seed_complete("tt777", ROOT, &seed, 500);
    harness
        .apply("hdr", &[pagina_de_filme()], 1_000)
        .await
        .unwrap();
    assert!(
        !harness.is_partial("tt777", ROOT, 1_000),
        "keepPartial preserva a completude existente"
    );
    assert_eq!(harness.lookup("tt777", ROOT, 1_000).len(), 2);
}

/// As opções enviadas ao índice são as do TS (`{ partial, keepPartial: true }`):
/// chave nova nasce parcial (o `before.length === 0` do TS) e o `keepPartial`
/// vai SEMPRE `true` — a raspagem nunca rebaixa uma chave completa.
#[tokio::test]
async fn gravacao_pede_parcial_para_chave_nova_e_keep_partial_sempre() {
    let harness = IngestHarness::new().with_catalog(StubCatalog::movie("tt777"));
    harness
        .apply("hdr", &[pagina_de_filme()], 1_000)
        .await
        .unwrap();
    assert_eq!(
        harness.record_opts(),
        vec![(true, true)],
        "chave nova: partial=true e keepPartial=true"
    );

    let harness = IngestHarness::new().with_catalog(StubCatalog::movie("tt777"));
    let seed = raw_item(
        "hdr",
        &release("Filme Teste 2024 1080p DUBLADO", HASH_D, true),
    );
    harness.seed_complete("tt777", ROOT, &seed, 500);
    harness
        .apply("hdr", &[pagina_de_filme()], 1_000)
        .await
        .unwrap();
    assert_eq!(
        harness.record_opts(),
        vec![(false, true)],
        "chave completa: partial=false e keepPartial=true"
    );
}

/// Fila cheia no banco vivo: `queueDropped`, retentável, sem tocar o índice.
#[tokio::test]
async fn fila_cheia_nao_grava_e_e_retentavel() {
    let harness = IngestHarness::new()
        .with_catalog(StubCatalog::movie("tt777"))
        .failing_capture();
    let err = harness
        .apply("hdr", &[pagina_de_filme()], 1_000)
        .await
        .unwrap_err();
    assert_eq!(err, IngestError::QueueDropped);
    assert!(err.retryable());
    assert_eq!(harness.index().count_live(1_000).unwrap(), 0);
    assert!(harness.invalidations().is_empty());
}

/// Barreira de persistência: sem `flush` confirmado a página não escreve no
/// índice nem invalida streams.
#[tokio::test]
async fn barreira_de_persistencia_falha_antes_do_indice() {
    let harness = IngestHarness::new()
        .with_catalog(StubCatalog::movie("tt777"))
        .failing_flush();
    let err = harness
        .apply("hdr", &[pagina_de_filme()], 1_000)
        .await
        .unwrap_err();
    assert_eq!(err, IngestError::FlushFailed);
    assert!(err.retryable());
    assert_eq!(harness.index().count_live(1_000).unwrap(), 0);
}

/// TMDB fora (`unavailable`) não é veredito: retentável, sem gravação.
#[tokio::test]
async fn catalogo_indisponivel_e_retentavel() {
    let harness = IngestHarness::new().with_catalog(StubCatalog::unavailable());
    let out = harness
        .apply("bludv", &[pagina_sem_imdb()], 1_000)
        .await
        .unwrap();
    assert_eq!(out.works, 0);
    assert_eq!(out.mark, Some(PageMark::Unavailable));
    assert!(out.retryable, "indisponível é retentável");
}

/// Contexto só do catálogo: sem nomes não há filtro confiável — erro
/// retentável e nenhuma escrita.
#[tokio::test]
async fn catalogo_sem_nomes_e_retentavel() {
    let harness = IngestHarness::new().with_catalog(StubCatalog::without_names());
    let err = harness
        .apply("hdr", &[pagina_de_filme()], 1_000)
        .await
        .unwrap_err();
    assert_eq!(err, IngestError::CatalogNoNames);
    assert!(err.retryable());
    assert_eq!(harness.index().count_live(1_000).unwrap(), 0);
}

/// A cerca do passo: `shouldAbort` antes da primeira escrita impede tudo.
#[tokio::test]
async fn abortar_antes_da_escrita_nao_grava() {
    let harness = IngestHarness::new().with_catalog(StubCatalog::movie("tt777"));
    let err = harness
        .apply_guarded("hdr", &pagina_de_filme(), 1_000, &|| true)
        .await
        .unwrap_err();
    assert_eq!(err, IngestError::Aborted);
    assert!(!err.retryable(), "passo fora do prazo não é retentável");
    assert_eq!(harness.index().count_live(1_000).unwrap(), 0);
    assert!(harness.invalidations().is_empty());
}

/// `no-work`: o motor já marcou a URL; a ingestão não gasta identificação.
#[tokio::test]
async fn pagina_no_work_nao_consulta_o_catalogo() {
    let harness = IngestHarness::new().with_catalog(StubCatalog::movie("tt777"));
    let mut page = pagina_de_filme();
    page.status = CrawlResultStatus::NoWork;
    let out = harness.apply("hdr", &[page], 1_000).await.unwrap();
    assert_eq!(out.mark, Some(PageMark::NoWork));
    assert_eq!(out.works, 0);
    assert!(harness.catalog_calls().is_empty());
}

// ── Réguas puras da locação ────────────────────────────────────────────────

/// `parseSizeBytes` do TS: primeiro rótulo, vírgula decimal e o `Math.round`.
#[test]
fn tamanho_do_rotulo_vira_bytes_como_no_ts() {
    assert_eq!(parse_size_bytes("1.5 GB"), Some(1_610_612_736.0));
    assert_eq!(parse_size_bytes("700 MB"), Some(734_003_200.0));
    assert_eq!(parse_size_bytes("1,5gb"), Some(1_610_612_736.0));
    assert_eq!(parse_size_bytes("2 TB"), Some(2_199_023_255_552.0));
    assert_eq!(parse_size_bytes(""), None);
    assert_eq!(parse_size_bytes("sem tamanho"), None);
    assert_eq!(parse_size_bytes("1.234,5 GB"), None);
}

/// `toRawItem` da rota do Node: `indexer` do site, hash do magnet, tamanho em
/// bytes e seeders.
#[test]
fn release_da_pagina_vira_item_cru_com_indexer_do_site() {
    let mut rel = release("Filme Teste 2024 1080p DUBLADO", HASH_A, true);
    rel.seeders = Some(7);
    let item: RawItem = raw_item("hdr", &rel);
    assert_eq!(item.indexer.as_deref(), Some("hdr"));
    assert_eq!(item.tracker.as_deref(), Some("BLUDV"));
    assert_eq!(item.info_hash.as_deref(), Some(HASH_A));
    assert_eq!(item.seeders, Some(7.0));
    assert_eq!(item.size_bytes, Some(1_610_612_736.0));
    assert!(item.is_br);
    let wire = item.to_wire();
    assert_eq!(wire["indexer"], serde_json::json!("hdr"));
    assert_eq!(wire["size"], serde_json::json!(1_610_612_736.0));
}
