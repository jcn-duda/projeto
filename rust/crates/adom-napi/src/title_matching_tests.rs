use super::*;

/// (a) `shortNameIdentity` -> objeto napi -> enum do core, ida e volta.
#[test]
fn identidade_de_nome_curto_ida_e_volta() {
    let boys = short_name_identity_napi("The Boys".to_string());
    assert_eq!(boys.kind, "prefix");
    assert_eq!(boys.want.as_deref(), Some("boys"));
    assert_eq!(boys.run.as_deref(), Some(&["boys".to_string()][..]));
    let check = ShortNameIdentityNapi {
        kind: boys.kind.clone(),
        want: boys.want.clone(),
        run: boys.run.clone(),
    };
    assert!(matches_short_name_identity_napi(
        "The Boys S01 1080p".to_string(),
        check,
        None,
        String::new()
    ));
    // Outra obra que só contém o nome no meio: o portão nega.
    let check = ShortNameIdentityNapi {
        kind: boys.kind,
        want: boys.want,
        run: boys.run,
    };
    assert!(!matches_short_name_identity_napi(
        "The Hardy Boys S01 1080p".to_string(),
        check,
        None,
        String::new()
    ));
}

/// (b) Nome longo: o portão se cala (base com 3+ tokens).
#[test]
fn nome_longo_pula_o_portao() {
    // `nameCoverageTokens` conta só os tokens longos fora de artigo: "game"
    // e "thrones" são 2, então "Game of Thrones" ainda é base curta.
    assert_eq!(
        short_name_identity_napi("Game of Thrones".to_string()).kind,
        "prefix"
    );
    let long = short_name_identity_napi("Star Trek Discovery".to_string());
    assert_eq!(long.kind, "skip");
    assert!(long.want.is_none() && long.run.is_none());
    let a = short_name_identity_napi("It".to_string());
    assert_eq!(a.kind, "no-token");
}

/// (c) `kind` desconhecido cai em `skip` (fail-open), nunca em `prefix`.
#[test]
fn kind_desconhecido_e_skip() {
    let weird = ShortNameIdentityNapi {
        kind: "???".to_string(),
        want: Some("x".to_string()),
        run: None,
    };
    assert!(matches_short_name_identity_napi(
        "Coisa Qualquer".to_string(),
        weird,
        None,
        String::new()
    ));
}

/// (d) Marcadores de sequência: número vira texto e palavra sobrevive.
#[test]
fn marcadores_de_sequencia_como_texto() {
    let markers = extract_sequence_markers_napi("Scary Movie 2 2001".to_string());
    assert_eq!(markers, vec!["2".to_string()]);
    let word = extract_sequence_markers_napi("Batman O Cavaleiro das Trevas Ressurge".to_string());
    assert_eq!(word, vec!["ressurge".to_string()]);
    assert!(extract_sequence_markers_napi("Scary Movie".to_string()).is_empty());
}

/// (e) `firstWorkToken` devolve `None` (undefined no napi) sem token latino.
#[test]
fn primeiro_token_de_obra_ausente() {
    assert_eq!(
        first_work_token_napi(vec!["1080p".to_string(), "web".to_string()]),
        None
    );
    assert_eq!(
        first_work_token_napi(vec!["1080p".to_string(), "filme".to_string()]),
        Some("filme".to_string())
    );
    // "光環" tem 2 unidades UTF-16: entra como rótulo, como no TS.
    assert_eq!(first_unmarked_token_napi(vec!["光環".to_string()]), None);
    assert_eq!(
        first_unmarked_token_napi(vec!["進撃の巨人".to_string()]),
        Some("進撃の巨人".to_string())
    );
}

/// (f) `episodeWorkTokens` ausente sem SxxEyy (undefined, não lista vazia).
#[test]
fn trecho_de_obra_ausente_sem_marcador() {
    assert_eq!(
        episode_work_tokens_napi(vec!["filme".to_string(), "2019".to_string()]),
        None
    );
    assert_eq!(
        episode_work_tokens_napi(vec![
            "serie".to_string(),
            "s01e02".to_string(),
            "nome".to_string()
        ]),
        Some(vec!["serie".to_string()])
    );
}

/// (g) `admitsMultiWorkPack` exige raiz, ano, nomes e evidência de coleção.
#[test]
fn admissao_de_pack_multiobra() {
    let names = vec!["Indiana Jones e os Caçadores da Arca Perdida".to_string()];
    let titulo = "Indiana Jones A Coleção Completa 1981-2008 Dublado";
    assert!(admits_multi_work_pack_napi(
        titulo.to_string(),
        String::new(),
        Some("indiana jones".to_string()),
        "1981".to_string(),
        false,
        names.clone()
    ));
    // Sem nomes não há dica de obra: nega.
    assert!(!admits_multi_work_pack_napi(
        titulo.to_string(),
        String::new(),
        Some("indiana jones".to_string()),
        "1981".to_string(),
        false,
        Vec::new()
    ));
    // Raiz ausente nega.
    assert!(!admits_multi_work_pack_napi(
        titulo.to_string(),
        String::new(),
        None,
        "1981".to_string(),
        false,
        names
    ));
}

/// (h) `filterBrAliases`: null/vazio é ausente, teto de 2, ordem preservada.
#[test]
fn aliases_br_filtrados() {
    let out = filter_br_aliases_napi(
        vec![
            Some("Operação: Lioness".to_string()),
            Some("Lioness".to_string()),
            None,
            Some("Outra Obra".to_string()),
            Some("Leoa".to_string()),
        ],
        vec![Some("Lioness".to_string()), None],
    );
    assert_eq!(out, vec!["Operação: Lioness".to_string()]);
}

/// (i) `matchesGlobalSeriesNoMarker` e `matchesEpisodeWorkIdentity` com
/// `cutTail` nas duas posições.
#[test]
fn precisao_com_e_sem_corte_de_cauda() {
    let tokens = vec!["filme".to_string(), "1080p".to_string(), "x264".to_string()];
    let universe = vec!["filme".to_string()];
    assert!(matches_global_series_no_marker_napi(
        "Filme".to_string(),
        tokens.clone(),
        universe.clone(),
        true
    ));
    assert!(matches_episode_work_identity_napi(
        "Filme S01E02 1080p".to_string(),
        Some(vec!["Filme".to_string()]),
        None,
        None,
        false
    ));
    // Sem nomes a guarda não mede: true, como no TS.
    assert!(matches_episode_work_identity_napi(
        "Outra Coisa S01E02".to_string(),
        None,
        None,
        None,
        true
    ));
}
