//! Veredictos da identificação com a API crua injetada (sem rede).
//!
//! O stub NÃO filtra ano — quem filtra é `search_by_title`, exercitado em
//! `identify_http_tests.rs` com o cliente real. Aqui ficam o casamento estrito,
//! o ambíguo, o estado próprio e as duas falhas RETENTÁVEIS.

use super::super::search::SearchWorkType;
use super::{
    identify, select_candidate, strict_name_matches, CandidateSelection, IdentifyInput,
    IdentifyOutcome,
};
use crate::tmdb::stub::{hit, StubTmdb};

fn movie_input<'a>(title: &'a str, year: i64) -> IdentifyInput<'a> {
    IdentifyInput {
        kind: SearchWorkType::Movie,
        title,
        year: Some(year),
        ..IdentifyInput::default()
    }
}

#[tokio::test]
async fn pagina_sem_ano_nao_identifica_nem_busca() {
    let stub = StubTmdb::movie("Homonimo Solo", 2013, "tt1111111");
    for year in [None, Some(0)] {
        let result = identify(
            &stub,
            &IdentifyInput {
                title: "Homonimo Solo",
                year,
                ..IdentifyInput::default()
            },
        )
        .await;
        assert_eq!(result.outcome, IdentifyOutcome::Unidentified);
        assert_eq!(result.imdb, None);
        assert_eq!(result.reason, "pagina-sem-ano");
    }
    assert!(
        stub.calls().is_empty(),
        "sem ano não há consulta nem aceitação de homônimo"
    );
}

#[tokio::test]
async fn pagina_sem_titulo_nao_identifica_nem_busca() {
    let stub = StubTmdb::movie("Qualquer", 2020, "tt1111111");
    let result = identify(
        &stub,
        &IdentifyInput {
            title: "   ",
            year: Some(2020),
            ..IdentifyInput::default()
        },
    )
    .await;
    assert_eq!(result.outcome, IdentifyOutcome::Unidentified);
    assert_eq!(result.reason, "pagina-sem-titulo");
    assert!(stub.calls().is_empty(), "título vazio não busca");
}

#[tokio::test]
async fn homonimo_ambiguo_devolve_none_sem_consultar_imdb() {
    let stub = StubTmdb::with_hits(vec![
        hit(401, "Gêmeos", "Gêmeos", Some(2013)),
        hit(402, "Gêmeos", "Gêmeos", Some(2013)),
    ]);
    let result = identify(&stub, &movie_input("Gêmeos", 2013)).await;
    assert_eq!(result.outcome, IdentifyOutcome::Ambiguous);
    assert_eq!(
        result.imdb, None,
        "ambíguo é null: o mais famoso não é o certo"
    );
    assert_eq!(result.reason, "homonimo-ambiguo");
    assert!(
        !stub
            .calls()
            .iter()
            .any(|call| call.starts_with("external:")),
        "ambíguo não resolve IMDb: {:?}",
        stub.calls()
    );
}

#[tokio::test]
async fn nome_parecido_nao_casa_igualdade_estrita() {
    let stub = StubTmdb::with_hits(vec![
        hit(701, "Fallout 4", "Fallout 4", Some(2024)),
        hit(702, "A Queda: Fallout", "Fallout: The Fall", Some(2024)),
    ]);
    let result = identify(&stub, &movie_input("Fallout", 2024)).await;
    assert_eq!(result.outcome, IdentifyOutcome::Unidentified);
    assert_eq!(result.imdb, None);
    assert_eq!(result.reason, "nome-sem-casamento");
}

#[tokio::test]
async fn obra_sem_imdb_e_estado_proprio_nao_retentavel() {
    let stub =
        StubTmdb::with_hits(vec![hit(801, "Sem IMDb", "Sem IMDb", Some(2020))]).without_imdb();
    let result = identify(&stub, &movie_input("Sem IMDb", 2020)).await;
    assert_eq!(result.outcome, IdentifyOutcome::Unidentified);
    assert_eq!(result.reason, "obra-sem-imdb");
    assert_eq!(result.tmdb_id, Some(801));
    assert!(
        !result.outcome.is_retryable(),
        "a obra existe; retentar não muda"
    );
}

#[tokio::test]
async fn busca_indisponivel_e_retentavel() {
    let stub = StubTmdb::movie("Falha", 2020, "tt1111111").with_search_failure();
    let result = identify(&stub, &movie_input("Falha", 2020)).await;
    assert_eq!(result.outcome, IdentifyOutcome::Unavailable);
    assert_eq!(result.reason, "tmdb-indisponivel");
    assert!(
        result.outcome.is_retryable(),
        "500 ao sidecar: pode retentar"
    );
}

#[tokio::test]
async fn external_indisponivel_e_retentavel_com_o_tmdb_id() {
    let stub = StubTmdb::with_hits(vec![hit(901, "Ext Falha", "Ext Falha", Some(2020))])
        .with_external_failure();
    let result = identify(&stub, &movie_input("Ext Falha", 2020)).await;
    assert_eq!(result.outcome, IdentifyOutcome::Unavailable);
    assert_eq!(result.reason, "tmdb-external-indisponivel");
    assert_eq!(
        result.tmdb_id,
        Some(901),
        "a obra única veio antes da falha"
    );
    assert!(result.outcome.is_retryable());
}

#[tokio::test]
async fn busca_vazia_autoritativa_e_unidentified() {
    let stub = StubTmdb::with_hits(vec![]);
    let result = identify(&stub, &movie_input("Vazio", 2020)).await;
    assert_eq!(result.outcome, IdentifyOutcome::Unidentified);
    assert_eq!(result.reason, "tmdb-sem-resultado");
    assert!(
        !result.outcome.is_retryable(),
        "vazio autoritativo não é falha"
    );
}

#[tokio::test]
async fn pt_x_en_casa_o_titulo_localizado() {
    let stub = StubTmdb::with_hits(vec![hit(
        501,
        "Expresso do Amanhã",
        "Snowpiercer",
        Some(2013),
    )]);
    let result = identify(&stub, &movie_input("Expresso do Amanhã", 2013)).await;
    assert_eq!(result.outcome, IdentifyOutcome::Identified);
    assert_eq!(result.reason, "casamento-unico");
}

#[tokio::test]
async fn en_x_pt_casa_o_titulo_original_do_mesmo_candidato() {
    let stub = StubTmdb::with_hits(vec![hit(
        501,
        "Expresso do Amanhã",
        "Snowpiercer",
        Some(2013),
    )]);
    let result = identify(&stub, &movie_input("Snowpiercer", 2013)).await;
    assert_eq!(result.outcome, IdentifyOutcome::Identified);
    assert_eq!(result.imdb.as_deref(), Some("tt0000001"));
}

#[tokio::test]
async fn titulo_original_desempata_o_homonimo() {
    let stub = StubTmdb::with_hits(vec![
        hit(1, "A Besta", "The Beast", Some(2024)),
        hit(2, "A Besta", "La bête", Some(2024)),
    ]);
    let result = identify(
        &stub,
        &IdentifyInput {
            original_title: Some("La bête"),
            ..movie_input("A Besta", 2024)
        },
    )
    .await;
    assert_eq!(result.outcome, IdentifyOutcome::Identified);
    assert_eq!(
        result.tmdb_id,
        Some(2),
        "o original da ficha decide o homônimo"
    );
    assert_eq!(result.reason, "casamento-titulo-original");
}

#[test]
fn strict_name_matches_normaliza_sem_substring() {
    assert!(strict_name_matches(
        "Expresso do Amanhã!",
        &["EXPRESSO DO AMANHA"]
    ));
    assert!(!strict_name_matches(
        "Expresso do Amanhã",
        &["Expresso do Amanhã: Legado"]
    ));
    assert!(!strict_name_matches("", &["qualquer"]));
    assert!(!strict_name_matches("Filme", &["", ""]));
}

#[test]
fn select_candidate_separa_unica_ambigua_e_nenhuma() {
    let hit_a = hit(1, "X", "X", Some(2013));
    let hit_b = hit(2, "X", "X", Some(2014));
    assert!(matches!(
        select_candidate(std::slice::from_ref(&hit_a), "x", None, None),
        CandidateSelection::Unique {
            by_original: false,
            ..
        }
    ));
    assert!(matches!(
        select_candidate(&[hit_a, hit_b], "X", None, None),
        CandidateSelection::Ambiguous { .. }
    ));
    assert_eq!(
        select_candidate(&[hit(1, "X", "X", Some(2013))], "Y", None, None),
        CandidateSelection::NoMatch
    );
}
