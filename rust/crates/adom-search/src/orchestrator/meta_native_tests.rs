use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use adom_sources::{CollectionInfo, EpisodeAired, MediaType, MetaLookup};

fn query(id: &str, kind: &str) -> MetaQuery {
    MetaQuery {
        encoded: "e30".into(),
        kind: kind.into(),
        id: id.into(),
        include_multiwork: true,
        include_home_release: true,
        deadline_at_ms: None,
    }
}

fn movie_lookup() -> MetaLookup {
    let mut lookup = MetaLookup::empty("tt1160419", MediaType::Movie);
    lookup.meta_name = Some("Duna".into());
    lookup.year = Some("2021".into());
    lookup.title_pt = Some("Duna".into());
    lookup.title_en = Some("Dune".into());
    lookup.title_original = Some("Dune".into());
    lookup.titles_year = Some("2021".into());
    lookup.aliases_br = vec!["Duna: Parte 2".into()];
    lookup.names = vec!["Duna".into(), "Dune".into(), "Duna: Parte 2".into()];
    lookup.released = Some("2021-09-15T00:00:00.000Z".into());
    lookup.home_release_at = Some(1_634_083_200_000);
    lookup.collection = Some(CollectionInfo {
        name: "Duna Collection".into(),
        root: "duna".into(),
        years: vec![2021, 2024],
    });
    lookup.episodes_by_season.insert(1, 8);
    lookup
}

#[test]
fn filme_mapeia_titulos_ano_colecao_e_home_release() {
    let meta = meta_from_lookup(&movie_lookup(), &query("tt1160419", "movie"));
    assert_eq!(meta.imdb_id, "tt1160419");
    assert_eq!(meta.name, "Duna");
    assert_eq!(
        meta.names,
        vec!["Duna".to_string(), "Dune".into(), "Duna: Parte 2".into()]
    );
    assert_eq!(meta.year_text(), "2021");
    assert_eq!(meta.query, "Duna 2021");
    // pt difere do original: query pt-BR separada, título cru e sweep.
    assert_eq!(meta.pt_query.as_deref(), Some("Duna 2021"));
    assert_eq!(meta.pt_title.as_deref(), Some("Duna"));
    assert_eq!(meta.sweep_query.as_deref(), Some("Duna"));
    assert_eq!(meta.original_query.as_deref(), Some("Dune"));
    assert_eq!(meta.multi_work_root.as_deref(), Some("duna"));
    assert_eq!(meta.multi_work_query.as_deref(), Some("duna"));
    assert_eq!(meta.home_release_at, Some(1_634_083_200_000));
    assert_eq!(meta.released.as_deref(), Some("2021-09-15T00:00:00.000Z"));
    assert_eq!(meta.episode_counts, vec![(1, 8)]);
    assert_eq!(
        meta.titles.expect("contexto DUAL").pt.as_deref(),
        Some("Duna")
    );
}

#[test]
fn colecao_sem_ano_de_catalogo_nao_vira_raiz() {
    let mut lookup = movie_lookup();
    lookup.year = None;
    let meta = meta_from_lookup(&lookup, &query("tt1160419", "movie"));
    assert!(meta.multi_work_root.is_none());
    assert!(meta.multi_work_query.is_none());
}

#[test]
fn serie_leva_data_do_episodio_e_contagem() {
    let mut lookup = MetaLookup::empty("tt0944947", MediaType::Series);
    lookup.meta_name = Some("Game of Thrones".into());
    lookup.year = Some("2011–2019".into());
    lookup.title_pt = Some("Game of Thrones".into());
    lookup.title_en = Some("Game of Thrones".into());
    lookup.title_original = Some("Game of Thrones".into());
    lookup.titles_year = Some("2011".into());
    lookup.names = vec!["Game of Thrones".into()];
    lookup.episodes_by_season.insert(8, 6);
    lookup.episode_aired.push(EpisodeAired {
        season: 8,
        episode: 3,
        date: "2019-04-29T05:00:00.000Z".into(),
    });
    let meta = meta_from_lookup(&lookup, &query("tt0944947:8:3", "series"));
    assert_eq!(meta.season, Some(8));
    assert_eq!(meta.episode, Some(3));
    assert_eq!(meta.query, "Game of Thrones S08E03");
    // Só a data do EPISÓDIO alimenta a guarda de 48h (e o unaired de 24h).
    assert_eq!(
        meta.episode_aired_at_ms,
        adom_core::parse_date_ms("2019-04-29T05:00:00.000Z")
    );
    // `meta.firstAired ?? episodeAired[S:E]`: sem firstAired da obra, vale a
    // data do episódio.
    assert_eq!(
        meta.first_aired.as_deref(),
        Some("2019-04-29T05:00:00.000Z")
    );
    assert_eq!(meta.episode_counts, vec![(8, 6)]);
    // Série não pede coleção nem data doméstica.
    assert!(meta.multi_work_root.is_none());
    assert!(meta.home_release_at.is_none());
}

#[test]
fn first_aired_da_obra_vence_a_data_do_episodio() {
    let mut lookup = MetaLookup::empty("tt0944947", MediaType::Series);
    lookup.meta_name = Some("Game of Thrones".into());
    lookup.first_aired = Some("2011-04-17".into());
    lookup.episode_aired.push(EpisodeAired {
        season: 8,
        episode: 3,
        date: "2019-04-29T05:00:00.000Z".into(),
    });
    let meta = meta_from_lookup(&lookup, &query("tt0944947:8:3", "series"));
    assert_eq!(meta.first_aired.as_deref(), Some("2011-04-17"));
    // A guarda continua com a data do EPISÓDIO.
    assert_eq!(
        meta.episode_aired_at_ms,
        adom_core::parse_date_ms("2019-04-29T05:00:00.000Z")
    );
}

#[test]
fn query_pt_usa_o_ano_do_tmdb_nao_o_ano_escolhido() {
    // Node: `buildSearchQuery({ name: titles.pt, year: titles.year })` — o ano
    // do TMDB. O nome principal usa o ano de catálogo (Cinemeta aqui).
    let mut lookup = movie_lookup();
    lookup.year = Some("2018".into());
    lookup.titles_year = Some("2021".into());
    lookup.title_pt = Some("Duna".into());
    lookup.title_original = Some("Dune".into());
    let meta = meta_from_lookup(&lookup, &query("tt1160419", "movie"));
    assert_eq!(meta.year_text(), "2018");
    assert_eq!(meta.query, "Duna 2018");
    assert_eq!(meta.pt_query.as_deref(), Some("Duna 2021"));
}

// ── Fallback Node ──────────────────────────────────────────────────────────

// Métricas `meta.*` de instância própria: casos paralelos não disputam a global.
use super::super::meta_metrics::{
    MetaMetrics, FALLBACK_EMPTY, FALLBACK_ERROR, FALLBACK_USED, NATIVE_ERROR, NATIVE_INCOMPLETE,
    NATIVE_OK, RESOLVE_TOTAL,
};

struct Stub {
    result: Result<SearchMeta, String>,
    calls: AtomicUsize,
}

impl Stub {
    fn ok(name: &str) -> Arc<Self> {
        let mut meta = SearchMeta::from_id("tt1");
        meta.name = name.into();
        Arc::new(Self {
            result: Ok(meta),
            calls: AtomicUsize::new(0),
        })
    }

    fn err() -> Arc<Self> {
        Arc::new(Self {
            result: Err("rede fora".into()),
            calls: AtomicUsize::new(0),
        })
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl MetaSource for Stub {
    fn resolve<'a>(&'a self, _req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result.clone()
        })
    }
}

fn nome(meta: &SearchMeta) -> Value {
    json!(meta.name)
}

#[tokio::test]
async fn fallback_usa_o_node_quando_o_nativo_falha() {
    let native = Stub::err();
    let node = Stub::ok("Do Node");
    let metrics = MetaMetrics::new();
    let source = FallbackMetaSource::with_metrics(
        native.clone() as Arc<dyn MetaSource>,
        node.clone() as Arc<dyn MetaSource>,
        metrics.clone(),
    );
    let meta = source.resolve(query("tt1", "movie")).await.expect("Node");
    assert_eq!(nome(&meta), json!("Do Node"));
    assert_eq!(native.calls(), 1);
    assert_eq!(node.calls(), 1);
    // (3) primário Err + Node Ok: erro do nativo e uso do Node contados.
    assert_eq!(metrics.get(NATIVE_ERROR), 1);
    assert_eq!(metrics.get(FALLBACK_USED), 1);
    assert_eq!(metrics.get(RESOLVE_TOTAL), 1);
}

#[tokio::test]
async fn fallback_usa_o_node_quando_o_nativo_volta_sem_nome() {
    let native = Stub::ok("");
    let node = Stub::ok("Do Node");
    let metrics = MetaMetrics::new();
    let source = FallbackMetaSource::with_metrics(
        native.clone() as Arc<dyn MetaSource>,
        node.clone() as Arc<dyn MetaSource>,
        metrics.clone(),
    );
    let meta = source.resolve(query("tt1", "movie")).await.expect("Node");
    assert_eq!(nome(&meta), json!("Do Node"));
    assert_eq!(node.calls(), 1);
    assert_eq!(metrics.get(NATIVE_INCOMPLETE), 1);
}

#[tokio::test]
async fn nativo_bom_nao_chama_o_node() {
    let native = Stub::ok("Do Nativo");
    let node = Stub::ok("Do Node");
    let metrics = MetaMetrics::new();
    let source = FallbackMetaSource::with_metrics(
        native.clone() as Arc<dyn MetaSource>,
        node.clone() as Arc<dyn MetaSource>,
        metrics.clone(),
    );
    let meta = source.resolve(query("tt1", "movie")).await.expect("nativo");
    assert_eq!(nome(&meta), json!("Do Nativo"));
    assert_eq!(node.calls(), 0);
    // (2) título real no primário: `meta.native.ok`, sem chamar o Node.
    assert_eq!(metrics.get(NATIVE_OK), 1);
}

/// (1) `name == imdb_id`: o caso que o gate de nome vazio NÃO enxerga. O
/// primário volta como está e o Node NÃO é chamado.
#[tokio::test]
async fn nativo_incompleto_com_imdb_nao_chama_o_node() {
    let native = Stub::ok("tt1");
    let node = Stub::ok("Do Node");
    let metrics = MetaMetrics::new();
    let source = FallbackMetaSource::with_metrics(
        native.clone() as Arc<dyn MetaSource>,
        node.clone() as Arc<dyn MetaSource>,
        metrics.clone(),
    );
    let meta = source.resolve(query("tt1", "movie")).await.expect("nativo");
    assert_eq!(nome(&meta), json!("tt1"));
    assert_eq!(node.calls(), 0);
    assert_eq!(metrics.get(NATIVE_INCOMPLETE), 1);
    // Nenhum `meta.fallback.*` quando o Node nem é chamado.
    assert_eq!(metrics.get(FALLBACK_USED), 0);
    assert_eq!(metrics.get(FALLBACK_EMPTY), 0);
    assert_eq!(metrics.get(FALLBACK_ERROR), 0);
}

/// (4) primário Err + Node Err: propaga o erro do Node como hoje, contando os
/// dois erros.
#[tokio::test]
async fn node_com_erro_propaga_e_conta() {
    let native = Stub::err();
    let node = Stub::err();
    let metrics = MetaMetrics::new();
    let source = FallbackMetaSource::with_metrics(
        native.clone() as Arc<dyn MetaSource>,
        node.clone() as Arc<dyn MetaSource>,
        metrics.clone(),
    );
    let err = source
        .resolve(query("tt1", "movie"))
        .await
        .expect_err("Node Err propaga");
    assert_eq!(err, "rede fora");
    assert_eq!(node.calls(), 1);
    assert_eq!(metrics.get(NATIVE_ERROR), 1);
    assert_eq!(metrics.get(FALLBACK_ERROR), 1);
    assert_eq!(metrics.get(RESOLVE_TOTAL), 1);
}

/// (5) primário Ok vazio + Node Ok vazio: nada de título real sai daqui, e o
/// valor devolvido continua sendo o do caminho de hoje (o Ok do Node).
#[tokio::test]
async fn node_ok_sem_titulo_conta_vazio_e_devolve_parcial() {
    let native = Stub::ok("");
    let node = Stub::ok("");
    let metrics = MetaMetrics::new();
    let source = FallbackMetaSource::with_metrics(
        native.clone() as Arc<dyn MetaSource>,
        node.clone() as Arc<dyn MetaSource>,
        metrics.clone(),
    );
    let meta = source
        .resolve(query("tt1", "movie"))
        .await
        .expect("Node Ok");
    assert_eq!(nome(&meta), json!(""));
    assert_eq!(node.calls(), 1);
    assert_eq!(metrics.get(NATIVE_INCOMPLETE), 1);
    assert_eq!(metrics.get(FALLBACK_EMPTY), 1);
}

/// (6) o denominador bate com o número de chamadas a `resolve`.
#[tokio::test]
async fn resolve_total_bate_com_as_chamadas() {
    let native = Stub::ok("Do Nativo");
    let node = Stub::ok("Do Node");
    let metrics = MetaMetrics::new();
    let source = FallbackMetaSource::with_metrics(
        native.clone() as Arc<dyn MetaSource>,
        node.clone() as Arc<dyn MetaSource>,
        metrics.clone(),
    );
    for _ in 0..3 {
        let meta = source.resolve(query("tt1", "movie")).await.expect("nativo");
        assert_eq!(nome(&meta), json!("Do Nativo"));
    }
    assert_eq!(metrics.get(RESOLVE_TOTAL), 3);
    assert_eq!(metrics.get(NATIVE_OK), 3);
    assert_eq!(native.calls(), 3);
    assert_eq!(node.calls(), 0);
}

// ── episodeAired → guarda de 48h (ponta a ponta no build) ──────────────────

const PRE_AIR_HASH: &str = "0123456789abcdef0123456789abcdef01234567";

async fn streams_para(aired_at: Option<i64>, published_at: f64, now: i64) -> usize {
    use crate::orchestrator::tests::test_support as support;
    use crate::MemorySwrStore;

    let mut meta = support::meta();
    meta.season = Some(1);
    meta.episode = Some(1);
    meta.query = "Filme Teste S01E01".into();
    meta.episode_aired_at_ms = aired_at;
    let mut item = support::item(PRE_AIR_HASH);
    item.title = Some("Filme Teste S01E01 2024 1080p WEB-DL x264".into());
    item.published_at = Some(published_at);
    let collector = support::StubCollector::with(vec![item]);
    let config = support::config();
    let orch = support::orchestrator(
        config,
        Arc::new(MemorySwrStore::new()),
        collector,
        &[PRE_AIR_HASH],
    )
    .with_meta(Arc::new(support::StubMeta(meta)));
    let mut req = support::request(now);
    req.kind = "series".into();
    req.id = "tt0133093:1:1".into();
    // Lista vazia ainda traz o AVISO (`externalUrl`); só conta stream tocável.
    orch.handle(req)
        .await
        .streams
        .iter()
        .filter(|stream| stream.url.is_some() || stream.info_hash.is_some())
        .count()
}

/// O item global publicado ANTES da estreia menos a margem é falso (torrent é
/// imutável); a MESMA release publicada dentro da margem fica. Prova que a
/// data do episódio sai do metadado e chega ao `BuildContext`.
#[tokio::test]
async fn episode_aired_real_liga_a_guarda_de_pre_air() {
    let air = adom_core::parse_date_ms("2026-10-05").expect("data");
    let now = air + 86_400_000;
    let margem = 48 * 3_600_000;

    assert_eq!(
        streams_para(Some(air), (air - margem + 3_600_000) as f64, now).await,
        1,
        "release publicada 47h antes NÃO é pré-air"
    );
    assert_eq!(
        streams_para(Some(air), (air - margem - 3_600_000) as f64, now).await,
        0,
        "release publicada 49h antes da estreia tem que sair"
    );
    // Sem a data do episódio a guarda não roda (era o bug do C5).
    assert_eq!(
        streams_para(None, (air - margem - 3_600_000) as f64, now).await,
        1,
        "sem episodeAired a guarda não tem como rodar"
    );
}
