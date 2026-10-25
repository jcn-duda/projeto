//! Testes do porte da busca por TÍTULO: query SEM ano, cache e filtro ±1.
//! O dublê HTTP local evita a rede real; a identificação em si mora em
//! `identify_tests.rs` e `identify_http_tests.rs`.

use serde_json::json;

use super::{series_started_by, year_within_tolerance};
use crate::tmdb::test_support::{client, ids, movie};
use crate::tmdb::{SearchByTitleOptions, SearchWorkType};

#[tokio::test]
async fn busca_nao_leva_ano_na_query_e_filtra_localmente() {
    let (api, base) = crate::tmdb::test_support::FakeTmdb::start(|_| {
        (
            200,
            json!({ "results": [
                movie(101, "Os Incriveis", "The Incredibles", "2004-11-05"),
                movie(102, "Os Incriveis 2", "Incredibles 2", "2018-06-15"),
            ] }),
        )
    })
    .await;
    let client = client(&base, "test-key");
    let near = tmdb_search(&client, "Probe Filter", Some(2005)).await;
    assert!(near.ok, "a API respondeu");
    assert_eq!(ids(&near), vec![101], "só 2004 sobrevive ao ±1 de 2005");

    let target = api.calls()[0].clone();
    assert!(
        target.starts_with("/search/movie"),
        "rota de filme: {target}"
    );
    assert!(target.contains("api_key=test-key"), "{target}");
    assert!(target.contains("language=pt-BR"), "{target}");
    assert!(target.contains("include_adult=false"), "{target}");
    assert!(target.contains("query=Probe+Filter"), "{target}");
    assert!(
        !target.contains("year="),
        "o ano NÃO vai na query: ±1 é filtro local — {target}"
    );
}

#[tokio::test]
async fn cache_serve_dois_anos_sem_nova_rede() {
    let (api, base) = crate::tmdb::test_support::FakeTmdb::start(|_| {
        (
            200,
            json!({ "results": [movie(101, "Obra", "Work", "2004-11-05")] }),
        )
    })
    .await;
    let client = client(&base, "test-key");
    let first = tmdb_search(&client, "Probe Cache", Some(2005)).await;
    let second = tmdb_search(&client, "Probe Cache", Some(2005)).await;
    assert_eq!(ids(&first), vec![101]);
    assert_eq!(ids(&second), vec![101], "o cache serve o mesmo hit");
    assert_eq!(api.calls().len(), 1, "a segunda busca não bate na API");
}

#[tokio::test]
async fn hit_sem_ano_e_descartado_com_ano_na_pagina() {
    let (api, base) = crate::tmdb::test_support::FakeTmdb::start(|_| {
        (
            200,
            json!({ "results": [movie(201, "Obra Sem Data", "No Date Work", "")] }),
        )
    })
    .await;
    let client = client(&base, "test-key");
    let with_year = tmdb_search(&client, "Probe Sem Ano", Some(2013)).await;
    assert_eq!(
        with_year.hits,
        vec![],
        "sem ano no candidato não há como conferir"
    );
    let no_year = tmdb_search(&client, "Probe Sem Ano", None).await;
    assert_eq!(no_year.hits.len(), 1, "sem ano na página o candidato vale");
    assert_eq!(
        api.calls().len(),
        1,
        "a MESMA entrada de cache serve os dois anos"
    );
}

#[test]
fn filtro_de_ano_e_janela_de_estreia() {
    // ±1 do ano da página; candidato sem ano NUNCA passa com ano conhecido.
    assert!(year_within_tolerance(Some(2014), Some(2013)));
    assert!(year_within_tolerance(Some(2012), Some(2013)));
    assert!(!year_within_tolerance(Some(2011), Some(2013)));
    assert!(!year_within_tolerance(None, Some(2013)));
    assert!(
        year_within_tolerance(None, None),
        "sem ano de página tudo passa"
    );

    // Série de temporada N≥2: estreia até +1 do ano da página, teto de 40 anos.
    assert!(series_started_by(Some(2015), Some(2018)));
    assert!(
        series_started_by(Some(2019), Some(2018)),
        "+1 do lançamento BR é aceito"
    );
    assert!(
        !series_started_by(Some(2020), Some(2018)),
        "estreia depois da janela não é a série da página"
    );
    assert!(
        !series_started_by(Some(1970), Some(2018)),
        "além do teto de 40 anos"
    );
}

/// Atalho: busca de filme com o filtro local do caller.
async fn tmdb_search(
    client: &crate::tmdb::TmdbClient,
    title: &str,
    year: Option<i64>,
) -> crate::tmdb::TmdbSearchResult {
    crate::tmdb::search_by_title(
        client,
        SearchWorkType::Movie,
        title,
        year,
        SearchByTitleOptions::default(),
    )
    .await
}
