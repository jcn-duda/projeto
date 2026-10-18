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
}
