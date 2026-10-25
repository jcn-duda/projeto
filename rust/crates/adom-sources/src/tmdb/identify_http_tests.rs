//! Identificação com o CLIENTE real contra o TMDB falso: exercita o caminho
//! completo (busca → filtro ±1 → casamento → `external_ids`) e a
//! retentabilidade que o sidecar traduz em 500.

use serde_json::json;

use super::super::search::SearchWorkType;
use super::{identify, IdentifyInput, IdentifyOutcome};
use crate::tmdb::test_support::{client, input, movie, tv, FakeTmdb};

/// O teste que define o contrato (plano T3-L2): o filtro ±1 mora em
/// `search_by_title`, então só o cliente real o exercita.
#[tokio::test]
async fn identify_por_titulo_e_ano_devolve_imdb_ou_veredito() {
    let (_, base) = FakeTmdb::start(|target| {
        if target.contains("/search/movie") {
            return (
                200,
                json!({ "results": [movie(4242, "Interestelar", "Interstellar", "2014-11-07")] }),
            );
        }
        if target.contains("/movie/4242/external_ids") {
            return (200, json!({ "imdb_id": "tt0816692" }));
        }
        (404, json!({}))
    })
    .await;
    let client = client(&base, "test-key");

    let found = identify(&client, &input("Interestelar", Some(2014))).await;
    assert_eq!(found.outcome, IdentifyOutcome::Identified);
    assert_eq!(found.imdb.as_deref(), Some("tt0816692"));
    assert_eq!(found.tmdb_id, Some(4242));

    // Ano divergente cai fora do ±1 local: None, nunca o homônimo de outra época.
    let miss = identify(&client, &input("Interestelar", Some(1990))).await;
    assert_eq!(miss.outcome, IdentifyOutcome::Unidentified);
    assert_eq!(miss.imdb, None);
    assert_eq!(miss.reason, "tmdb-sem-resultado");
}

#[tokio::test]
async fn identificacao_resolve_o_imdb_pelo_external_ids() {
    let (api, base) = FakeTmdb::start(|target| {
        if target.contains("/search/movie") {
            return (
                200,
                json!({ "results": [movie(501, "Expresso do Amanha", "Snowpiercer", "2013-08-01")] }),
            );
        }
        if target.contains("/movie/501/external_ids") {
            return (200, json!({ "imdb_id": "tt1706620" }));
        }
        (404, json!({}))
    })
    .await;
    let client = client(&base, "test-key");
    let found = client
        .identify(&input("Expresso do Amanha", Some(2013)))
        .await;
    assert_eq!(found.outcome, IdentifyOutcome::Identified);
    assert_eq!(found.imdb.as_deref(), Some("tt1706620"));
    assert_eq!(found.tmdb_id, Some(501));
    assert_eq!(found.reason, "casamento-unico");
    assert!(
        api.calls()
            .iter()
            .any(|call| call.contains("/movie/501/external_ids?api_key=test-key")),
        "o IMDb vem do external_ids da obra única: {:?}",
        api.calls()
    );
}

#[tokio::test]
async fn falha_500_da_busca_vira_unavailable_retentavel() {
    let (api, base) = FakeTmdb::start(|_| (500, json!({ "status_message": "fora" }))).await;
    let client = client(&base, "test-key");
    let result = identify(&client, &input("Falha", Some(2020))).await;
    assert_eq!(result.outcome, IdentifyOutcome::Unavailable);
    assert!(
        result.outcome.is_retryable(),
        "500 ao sidecar: pode retentar"
    );
    assert_eq!(result.reason, "tmdb-indisponivel");
    assert_eq!(api.calls().len(), 1);
}

#[tokio::test]
async fn external_ids_indisponivel_vira_unavailable_com_o_tmdb_id() {
    let (_, base) = FakeTmdb::start(|target| {
        if target.contains("/search/movie") {
            return (
                200,
                json!({ "results": [movie(901, "Ext Falha", "Ext Falha", "2020-01-01")] }),
            );
        }
        (503, json!({}))
    })
    .await;
    let client = client(&base, "test-key");
    let result = identify(&client, &input("Ext Falha", Some(2020))).await;
    assert_eq!(result.outcome, IdentifyOutcome::Unavailable);
    assert_eq!(result.reason, "tmdb-external-indisponivel");
    assert_eq!(
        result.tmdb_id,
        Some(901),
        "a obra única veio antes da falha"
    );
}

#[tokio::test]
async fn sem_chave_nao_toca_a_rede() {
    let (api, base) = FakeTmdb::start(|_| (500, json!({}))).await;
    let client = client(&base, "");
    let result = identify(&client, &input("Qualquer", Some(2020))).await;
    assert_eq!(result.outcome, IdentifyOutcome::Unavailable);
    assert_eq!(result.reason, "tmdb-indisponivel");
    assert!(api.calls().is_empty(), "sem chave não há rede");
}

#[tokio::test]
async fn homonimo_fora_do_ano_nao_identifica() {
    let (api, base) = FakeTmdb::start(|target| {
        if target.contains("/search/movie") {
            return (
                200,
                json!({ "results": [
                    movie(301, "Hércules", "Hercules", "1997-06-27"),
                    movie(302, "Hercules", "Hercules", "2014-07-25"),
                ] }),
            );
        }
        (500, json!({}))
    })
    .await;
    let client = client(&base, "test-key");
    let result = identify(&client, &input("Hércules", Some(2005))).await;
    assert_eq!(result.outcome, IdentifyOutcome::Unidentified);
    assert_eq!(result.reason, "tmdb-sem-resultado");
    assert!(
        !api.calls().iter().any(|call| call.contains("external_ids")),
        "sem candidato no ano não há external_ids: {:?}",
        api.calls()
    );
}

#[tokio::test]
async fn serie_de_temporada_2_usa_a_janela_de_estreia() {
    let (_, base) = FakeTmdb::start(|target| {
        if target.contains("/search/tv") {
            return (
                200,
                json!({ "results": [tv(603, "Better Call Saul", "Better Call Saul", "2015-02-08")] }),
            );
        }
        if target.contains("/tv/603/external_ids") {
            return (200, json!({ "imdb_id": "tt3032476" }));
        }
        (404, json!({}))
    })
    .await;
    let client = client(&base, "test-key");
    let later = client
        .identify(&IdentifyInput {
            kind: SearchWorkType::Series,
            title: "Better Call Saul",
            year: Some(2018),
            season: Some(4),
            ..IdentifyInput::default()
        })
        .await;
    assert_eq!(
        later.outcome,
        IdentifyOutcome::Identified,
        "temporada 4 aceita estreia de 2015"
    );
    assert_eq!(later.imdb.as_deref(), Some("tt3032476"));

    // Temporada 1 mantém o ±1: a estreia de 2015 está fora de 2018.
    let first = identify(
        &client,
        &IdentifyInput {
            kind: SearchWorkType::Series,
            title: "Better Call Saul",
            year: Some(2018),
            season: Some(1),
            ..IdentifyInput::default()
        },
    )
    .await;
    assert_eq!(first.outcome, IdentifyOutcome::Unidentified);
    assert_eq!(first.reason, "tmdb-sem-resultado");
}

#[tokio::test]
async fn segunda_busca_pelo_original_recupera_a_obra() {
    let (api, base) = FakeTmdb::start(|target| {
        if target.contains("query=Rabbit+Trap") {
            return (
                200,
                json!({ "results": [movie(778, "Rabbit Trap", "Rabbit Trap", "2023-05-01")] }),
            );
        }
        if target.contains("/search/movie") {
            return (
                200,
                json!({ "results": [movie(777, "Outra Obra", "Other", "2023-01-01")] }),
            );
        }
        if target.contains("/movie/778/external_ids") {
            return (200, json!({ "imdb_id": "tt9999999" }));
        }
        (404, json!({}))
    })
    .await;
    let client = client(&base, "test-key");
    let result = identify(
        &client,
        &IdentifyInput {
            kind: SearchWorkType::Movie,
            title: "A Armadilha do Coelho",
            year: Some(2023),
            original_title: Some("Rabbit Trap"),
            ..IdentifyInput::default()
        },
    )
    .await;
    assert_eq!(result.outcome, IdentifyOutcome::Identified);
    assert_eq!(result.imdb.as_deref(), Some("tt9999999"));
    assert_eq!(
        api.calls().len(),
        3,
        "duas buscas (h1 e original) + external_ids: {:?}",
        api.calls()
    );
}
