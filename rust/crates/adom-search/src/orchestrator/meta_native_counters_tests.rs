//! Contadores do NATIVO (`meta.resolve.total`/`meta.native.*`) — a migração
//! do corte do fallback (plano 2026-10-31, passo 2). O dono dos números é o
//! [`NativeMetaSource::resolve`] via `record_native_outcome`: com a rota Node
//! desligada (passo 1, `meta_source(None)`), o `/metrics` segue vivo.
//!
//! O fio é provado SEM rede: Cinemeta pré-cacheado no store (o `get_meta`
//! devolve do cache, `adom-sources/src/cinemeta.rs:76-80`) e TMDB sem chave
//! (fail-open sem rede, `adom-sources/src/tmdb/mod.rs:115-117`). Os casos de
//! wrapper (`meta.fallback.*`) estão em `meta_native_tests.rs`.

use std::sync::Arc;

use super::*;
use adom_sources::{
    CacheValue, CinemetaMeta, MediaType, MemoryMetaStore, MetaSources, MetaStore, SourcesConfig,
};

// Métricas de instância própria: casos paralelos não disputam a global.
use super::super::meta_metrics::{
    MetaMetrics, FALLBACK_EMPTY, FALLBACK_ERROR, FALLBACK_USED, NATIVE_ERROR, NATIVE_INCOMPLETE,
    NATIVE_OK, RESOLVE_TOTAL,
};

/// `MetaQuery` do nativo SEM os opt-ins de rede extra (mesmo shape do corpus:
/// multiobra/data doméstica desligadas — nada além do Cinemeta cacheado).
fn query_nativa(id: &str, kind: &str) -> MetaQuery {
    MetaQuery {
        encoded: "e30".into(),
        kind: kind.into(),
        id: id.into(),
        include_multiwork: false,
        include_home_release: false,
        deadline_at_ms: None,
    }
}

/// Cinemeta tipado com o mínimo; o resto é default honesto.
fn cinemeta_com(nome: Option<&str>) -> CinemetaMeta {
    CinemetaMeta {
        name: nome.map(str::to_string),
        year: Some("2021".into()),
        media_type: MediaType::Movie,
        episodes_by_season: Default::default(),
        released: None,
        first_aired: None,
        episode_aired: Vec::new(),
    }
}

/// Fonte nativa com o Cinemeta PRÉ-CACHEADO. A chave repete o formato de
/// `cinemeta_key` (`meta:{tipo}:{imdb}`, `adom-sources/src/cache.rs:212-214`).
fn nativo_com_cinemeta(meta: CinemetaMeta) -> (NativeMetaSource, MetaMetrics) {
    let store = Arc::new(MemoryMetaStore::new());
    store.set(
        "meta:movie:tt1160419",
        CacheValue::Cinemeta(Some(meta)),
        86_400,
        adom_sources::now_ms(),
    );
    let sources =
        Arc::new(MetaSources::new(SourcesConfig::default(), store).expect("fontes em memória"));
    let metrics = MetaMetrics::new();
    (
        NativeMetaSource::with_metrics(sources, metrics.clone()),
        metrics,
    )
}

/// (2) nativo completo: `resolve.total` + `native.ok` NO nativo, ZERO
/// `fallback.*` — é o fio que o passo 1 do corte (desligar a rota) alimenta
/// sozinho, sem cegar o `/metrics`.
#[tokio::test]
async fn nativo_completo_conta_ok_e_denominador_sem_fallback() {
    let (source, metrics) = nativo_com_cinemeta(cinemeta_com(Some("Duna")));
    let meta = source
        .resolve(query_nativa("tt1160419", "movie"))
        .await
        .expect("nativo");
    assert_eq!(meta.name, "Duna");
    assert_eq!(metrics.get(RESOLVE_TOTAL), 1);
    assert_eq!(metrics.get(NATIVE_OK), 1);
    assert_eq!(metrics.get(NATIVE_INCOMPLETE), 0);
    assert_eq!(metrics.get(NATIVE_ERROR), 0);
    assert_eq!(metrics.get(FALLBACK_USED), 0);
    assert_eq!(metrics.get(FALLBACK_EMPTY), 0);
    assert_eq!(metrics.get(FALLBACK_ERROR), 0);
}

/// (1) `name` cai no IMDb quando os títulos faltaram: incomplete, nunca ok.
#[tokio::test]
async fn nativo_sem_titulo_conta_incomplete() {
    let (source, metrics) = nativo_com_cinemeta(cinemeta_com(None));
    let meta = source
        .resolve(query_nativa("tt1160419", "movie"))
        .await
        .expect("nativo");
    assert_eq!(meta.name, "tt1160419");
    assert_eq!(metrics.get(RESOLVE_TOTAL), 1);
    assert_eq!(metrics.get(NATIVE_INCOMPLETE), 1);
    assert_eq!(metrics.get(NATIVE_OK), 0);
}

/// Erro ANTES do lookup (tipo desconhecido — não sai da rede): error + total.
/// O mesmo `record_native_outcome` classifica o Err de rede em produção.
#[tokio::test]
async fn nativo_com_tipo_desconhecido_conta_error() {
    let (source, metrics) = nativo_com_cinemeta(cinemeta_com(Some("Duna")));
    let err = source
        .resolve(query_nativa("tt1160419", "anime"))
        .await
        .expect_err("tipo desconhecido");
    assert!(err.contains("tipo de metadados desconhecido"));
    assert_eq!(metrics.get(RESOLVE_TOTAL), 1);
    assert_eq!(metrics.get(NATIVE_ERROR), 1);
    assert_eq!(metrics.get(NATIVE_OK), 0);
}

/// (6) o denominador bate com o número de chamadas — agora no dono novo
/// (era o `resolve_total_bate_com_as_chamadas` do wrapper, que com Stub não
/// conta mais nada).
#[tokio::test]
async fn resolve_total_bate_com_as_chamadas_no_nativo() {
    let (source, metrics) = nativo_com_cinemeta(cinemeta_com(Some("Duna")));
    for _ in 0..3 {
        let meta = source
            .resolve(query_nativa("tt1160419", "movie"))
            .await
            .expect("nativo");
        assert_eq!(meta.name, "Duna");
    }
    assert_eq!(metrics.get(RESOLVE_TOTAL), 3);
    assert_eq!(metrics.get(NATIVE_OK), 3);
}
