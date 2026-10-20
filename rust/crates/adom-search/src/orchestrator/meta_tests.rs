use super::*;

fn response() -> MetaResponse {
    serde_json::from_value(json!({
        "ok": true,
        "type": "movie",
        "id": "tt0133093",
        "imdb_id": "tt0133093",
        "season": null,
        "episode": null,
        "meta": {
            "name": "Matrix",
            "year": "1999",
            "videos": [
                { "season": 1, "episode": 1 },
                { "season": 1, "episode": 2 },
                { "season": 2, "episode": 1 }
            ]
        },
        "titles": { "pt": "Matrix", "original": "The Matrix", "year": 1999 },
        "multiWork": { "root": "The Matrix Collection" }
    }))
    .expect("resposta válida")
}

fn query() -> MetaQuery {
    MetaQuery {
        encoded: "e30".into(),
        kind: "movie".into(),
        id: "tt0133093".into(),
        include_multiwork: true,
        include_home_release: false,
        deadline_at_ms: None,
    }
}

#[test]
fn resolve_a_obra_como_o_do_search() {
    let meta = meta_from_response(&response(), &query());
    assert_eq!(meta.imdb_id, "tt0133093");
    assert_eq!(meta.name, "Matrix");
    assert!(meta.names.contains(&"The Matrix".to_string()));
    assert_eq!(meta.year_text(), "1999");
    // `buildSearchQuery`: com S/E vazio é "Nome Ano".
    assert_eq!(meta.query, "Matrix 1999");
    // pt difere do original → query pt-BR; sweep pela raiz pt.
    assert_eq!(meta.pt_query.as_deref(), Some("Matrix 1999"));
    assert_eq!(meta.sweep_query.as_deref(), Some("Matrix"));
    assert_eq!(meta.original_query.as_deref(), Some("The Matrix"));
    // Coleção só vale com ano conhecido; a query é a raiz.
    assert_eq!(
        meta.multi_work_root.as_deref(),
        Some("The Matrix Collection")
    );
    assert_eq!(
        meta.multi_work_query.as_deref(),
        Some("The Matrix Collection")
    );
    assert_eq!(meta.episode_counts, vec![(1, 2), (2, 1)]);
    // Contexto do ptTitleDual: o build in-process recebe pt/original/en da
    // MESMA resposta de metadados, sem depender da flag da rota de coleta.
    let titles = meta.titles.expect("títulos do TMDB viram contexto");
    assert_eq!(titles.pt.as_deref(), Some("Matrix"));
    assert_eq!(titles.original.as_deref(), Some("The Matrix"));
    assert_eq!(titles.en, None);
}

#[test]
fn serie_usa_temporada_e_episodio_do_id() {
    let mut response = response();
    response.media_type = "series".into();
    response.id = "tt0903747:5:14".into();
    response.imdb_id = "tt0903747".into();
    response.season = None;
    response.episode = None;
    response.multi_work = None;
    let meta = meta_from_response(
        &response,
        &MetaQuery {
            id: "tt0903747:5:14".into(),
            kind: "series".into(),
            ..query()
        },
    );
    assert_eq!(meta.season, Some(5));
    assert_eq!(meta.episode, Some(14));
    assert_eq!(meta.query, "Matrix S05E14");
    assert!(meta.multi_work_root.is_none());
}

#[test]
fn sem_ano_nao_ha_raiz_multiobra() {
    let mut response = response();
    response.meta = Some(json!({ "name": "Sem Ano" }));
    response.titles = None;
    let meta = meta_from_response(&response, &query());
    assert_eq!(meta.query, "Sem Ano");
    assert!(meta.multi_work_root.is_none());
    assert!(meta.titles.is_none(), "sem titles não há contexto DUAL");
}

fn serie_response(aired: Value) -> MetaResponse {
    serde_json::from_value(json!({
        "ok": true,
        "type": "series",
        "id": "tt0903747:1:2",
        "imdb_id": "tt0903747",
        "season": 1,
        "episode": 2,
        "meta": {
            "name": "Série Teste",
            "year": "2026",
            "type": "series",
            "released": "2026-08-01T00:00:00.000Z",
            "firstAired": aired,
            "episodeAired": {
                "1:1": "2026-09-28T00:00:00.000Z",
                "1:2": "2026-10-05T00:00:00.000Z"
            }
        },
        "titles": { "pt": "Série Teste", "original": "Test Show", "year": "2026" },
        "homeReleaseAt": 1_700_000_000_000i64
    }))
    .expect("resposta de série")
}

#[test]
fn episode_aired_real_vira_ms_e_first_aired_segue_o_ts() {
    let meta = meta_from_response(&serie_response(json!("2026-09-01")), &query());
    // Só a data do EPISÓDIO alimenta as guardas de 48h/24h.
    assert_eq!(
        meta.episode_aired_at_ms,
        adom_core::parse_date_ms("2026-10-05T00:00:00.000Z")
    );
    // `meta.firstAired ?? episodeAired[S:E]`: a estreia da OBRA vence.
    assert_eq!(meta.first_aired.as_deref(), Some("2026-09-01"));
    assert_eq!(meta.released.as_deref(), Some("2026-08-01T00:00:00.000Z"));
    assert_eq!(meta.home_release_at, Some(1_700_000_000_000));
}

#[test]
fn sem_first_aired_da_obra_vale_a_data_do_episodio() {
    let meta = meta_from_response(&serie_response(Value::Null), &query());
    assert_eq!(
        meta.first_aired.as_deref(),
        Some("2026-10-05T00:00:00.000Z")
    );
    assert_eq!(
        meta.episode_aired_at_ms,
        adom_core::parse_date_ms("2026-10-05T00:00:00.000Z")
    );
}

#[test]
fn episodio_sem_data_nao_inventa_guarda() {
    let mut response = serie_response(Value::Null);
    let mut meta = response.meta.take().expect("meta");
    meta.as_object_mut().expect("objeto").remove("episodeAired");
    response.meta = Some(meta);
    let meta = meta_from_response(&response, &query());
    assert_eq!(meta.episode_aired_at_ms, None);
    // Sem `firstAired` da obra e sem `episodeAired`, não há data nenhuma.
    assert_eq!(meta.first_aired, None);
}
