//! Identidade de nomes numéricos/pontuados (`3%`, `24`, `9-1-1`, `11.22.63`)
//! direto nas APIs públicas do núcleo: `short_name_identity`,
//! `matches_short_name_identity` e `filter_relevant_raw`.
//!
//! O caso medido: `matchesName("3 body problem", "3%")` aprova pela cobertura
//! (1/1 token), e `shortNameIdentity` devolvia `NoToken`, então o portão se
//! calava e o pack "3 Body Problem S01 1080p" entrava na busca de `3%` S1.
//!
//! A régua nova não é lista de títulos proibidos: o `run` é a sequência
//! INTEIRA do nome, na ordem e com a multiplicidade originais, e a cauda só
//! aceita etiquetas (S/E, temporada, ano, idioma, qualidade) antes do marcador
//! de episódio.

use adom_core::{
    filter_relevant_raw, filter_series_episode, matches_short_name_identity, short_name_identity,
    EpisodeFilterItem, RelevanceItem, RelevanceQuery, RelevanceSettings, ShortNameIdentity,
};

fn prefix(name: &str) -> ShortNameIdentity {
    match short_name_identity(name) {
        ShortNameIdentity::Prefix {
            want,
            run,
            percent_spelling,
        } => ShortNameIdentity::Prefix {
            want,
            run,
            percent_spelling,
        },
        other => panic!("{name:?} deveria ser prefix, veio {other:?}"),
    }
}

fn run_of(name: &str) -> Vec<String> {
    match prefix(name) {
        ShortNameIdentity::Prefix { run, .. } => run,
        _ => unreachable!(),
    }
}

fn item(title: &str) -> RelevanceItem {
    RelevanceItem {
        title: Some(title.to_string()),
        ..Default::default()
    }
}

fn settings() -> RelevanceSettings {
    RelevanceSettings {
        now_ms: 0,
        pre_home_release_cut: false,
        pre_home_release_margin_ms: 0,
        title_precision_tail_cut: true,
    }
}

fn query<'a>(names: &'a [String], season: Option<i64>, episode: Option<i64>) -> RelevanceQuery<'a> {
    RelevanceQuery {
        names,
        year: "",
        alt_year: None,
        is_series: true,
        season,
        episode,
        multi_work_root: None,
        home_release_at: None,
    }
}

/// `true` quando o filtro de título mantém o item no shape pedido.
fn keeps(names: &[&str], title: &str, season: Option<i64>, episode: Option<i64>) -> bool {
    let names: Vec<String> = names.iter().map(|n| n.to_string()).collect();
    let items = [item(title)];
    let out = filter_relevant_raw(&items, &query(&names, season, episode), &settings());
    out.kept == [0]
}

#[test]
fn identidade_numerica_carrega_a_sequencia_completa_sem_dedup() {
    assert_eq!(
        prefix("3%"),
        ShortNameIdentity::Prefix {
            want: "3".to_string(),
            run: vec!["3".to_string()],
            percent_spelling: true,
        }
    );
    assert_eq!(run_of("24"), vec!["24".to_string()]);
    // A base de cobertura deduplica; o run NÃO: 9-1-1 tem dois "1".
    assert_eq!(
        run_of("9-1-1"),
        vec!["9".to_string(), "1".to_string(), "1".to_string()]
    );
    assert_eq!(
        run_of("11.22.63"),
        vec!["11".to_string(), "22".to_string(), "63".to_string()]
    );
}

#[test]
fn nomes_latinos_curtos_e_nao_latinos_ficam_no_token() {
    for name in ["V", "It", "Up", "Oz"] {
        assert_eq!(
            short_name_identity(name),
            ShortNameIdentity::NoToken,
            "{name}"
        );
    }
    // S.W.A.T. já tinha token latino: o prefixo de sempre continua.
    assert!(matches!(
        short_name_identity("S.W.A.T."),
        ShortNameIdentity::Prefix { .. }
    ));
    // Nome em outro script segue sem prova posicional (cobertura decide).
    assert_eq!(short_name_identity("光環"), ShortNameIdentity::NoToken);
}

#[test]
fn tres_por_cento_exige_identidade_completa_e_cauda_de_tag() {
    let check = short_name_identity("3%");
    for title in [
        "3% S01E01 1080p",
        "3%.S01.1080p.WEB-DL",
        "3% 2011 Dublado 1080p",
        "3% Temporada 3 Completa",
        "3% Primeira Temporada Completa",
        "3% Season 3 1080p",
        "3% (2011) DUAL 1080p",
        "[TGx] 3% S01 1080p",
    ] {
        assert!(
            matches_short_name_identity(title, &check, None, ""),
            "legítimo: {title}"
        );
    }
    for title in [
        "3 Body Problem S01 1080p",
        "3 Body Problem S01E01 1080p",
        "3 Body Problem Complete Series 1080p",
        "[TGx] 3 Body Problem S01 1080p",
    ] {
        assert!(
            !matches_short_name_identity(title, &check, None, ""),
            "homônimo: {title}"
        );
    }
    // dn real do magnet é evidência alternativa, como nos outros portões.
    assert!(matches_short_name_identity(
        "3 Body Problem S01E01",
        &check,
        None,
        "3% S01E01 1080p"
    ));
}

#[test]
fn vinte_e_quatro_nao_aceita_outra_obra_que_comeca_pelo_numero() {
    let check = short_name_identity("24");
    for title in [
        "24 S01E01 1080p",
        "24.S01.1080p.WEB-DL",
        "24 S01E01 12:00 PM - 1:00 PM",
        "24 Season 1 Complete 1080p",
        "24 First Season 1080p",
    ] {
        assert!(
            matches_short_name_identity(title, &check, None, ""),
            "legítimo: {title}"
        );
    }
    for title in [
        "24 Hours to Live 2017 1080p",
        "24 Legacy S01E01 1080p",
        "24 Redemption 2008 1080p",
    ] {
        assert!(
            !matches_short_name_identity(title, &check, None, ""),
            "homônimo: {title}"
        );
    }
}

#[test]
fn multiplicidade_de_9_1_1_e_ordem_de_11_22_63_sao_identidade() {
    let check = short_name_identity("9-1-1");
    assert!(matches_short_name_identity(
        "9-1-1 S01E01 1080p",
        &check,
        None,
        ""
    ));
    assert!(matches_short_name_identity(
        "9 1 1 S01E01 1080p",
        &check,
        None,
        ""
    ));
    assert!(!matches_short_name_identity(
        "9-1-1 Lone Star S01E01",
        &check,
        None,
        ""
    ));
    assert!(!matches_short_name_identity(
        "9 1 S01E01 1080p",
        &check,
        None,
        ""
    ));

    let check = short_name_identity("11.22.63");
    assert!(matches_short_name_identity(
        "11.22.63 S01E01 1080p",
        &check,
        None,
        ""
    ));
    assert!(!matches_short_name_identity(
        "11 22 64 S01E01 1080p",
        &check,
        None,
        ""
    ));
    assert!(!matches_short_name_identity(
        "11 22 63 Return S01E01",
        &check,
        None,
        ""
    ));
}

#[test]
fn filtro_relevante_corta_3_body_problem_nos_tres_shapes_de_serie() {
    // O pipeline chama o filtro de título sem season/episode (só isSeries),
    // então o pack e a série inteira também precisam ser barrados aqui.
    let shapes = [
        (Some(1), Some(1), "episódio"),
        (Some(1), None, "pack de temporada"),
        (None, None, "série inteira"),
    ];
    for (season, episode, shape) in shapes {
        for title in [
            "3 Body Problem S01 1080p",
            "3 Body Problem S01E01 1080p",
            "3 Body Problem COMPLETE 1080p",
        ] {
            assert!(!keeps(&["3%"], title, season, episode), "{shape}: {title}");
        }
        for title in [
            "3% S01 1080p",
            "3% S01E01 1080p",
            "3% 2016 Dublado 1080p",
            "3% Temporada 1 Completa",
        ] {
            assert!(keeps(&["3%"], title, season, episode), "{shape}: {title}");
        }
    }
}

#[test]
fn filtro_relevante_preserva_24_9_1_1_11_22_63_e_nomes_antigos() {
    for (name, legit, homonimo) in [
        ("24", "24 S01E01 1080p", "24 Hours to Live 2017 1080p"),
        (
            "9-1-1",
            "9-1-1 S01E01 1080p",
            "9-1-1 Lone Star S01E01 1080p",
        ),
        ("11.22.63", "11.22.63 S01E01 1080p", "11 22 64 S01E01 1080p"),
    ] {
        assert!(
            keeps(&[name], legit, Some(1), Some(1)),
            "legítimo {name}: {legit}"
        );
        assert!(
            !keeps(&[name], homonimo, Some(1), Some(1)),
            "homônimo {name}: {homonimo}"
        );
    }
    // Nomes de 1–2 letras, sigla e alias não latino: nada muda.
    for (name, title) in [
        ("It", "It S01E01 1080p"),
        ("Up", "Up S01E01 720p"),
        ("V", "V S01E01 1080p"),
        ("S.W.A.T.", "S.W.A.T. S01E01 1080p"),
        ("光環", "光環 S01E01 1080p"),
    ] {
        assert!(
            keeps(&[name], title, Some(1), Some(1)),
            "preservado {name}: {title}"
        );
    }
}

#[test]
fn filtro_de_episodio_continua_aceitando_os_legitimos_numericos() {
    // O portão de título (acima) roda ANTES deste no pipeline; aqui só se
    // garante que a release legítima não ganhou um corte novo.
    let items = [
        EpisodeFilterItem {
            title: Some("3% S01E01 1080p"),
            title_pascal: None,
            magnet: None,
            magnet_uri: None,
            guid: None,
            info_hash: None,
            from_account: false,
            is_br: false,
        },
        EpisodeFilterItem {
            title: Some("3% S01 1080p"),
            title_pascal: None,
            magnet: None,
            magnet_uri: None,
            guid: None,
            info_hash: None,
            from_account: false,
            is_br: false,
        },
    ];
    let names = vec!["3%".to_string()];
    let universe = vec!["3".to_string()];
    let out = filter_series_episode(&items, 1, 1, &universe, &names, false, &[], true);
    assert_eq!(out.kept, vec![0, 1]);
    assert!(out.rejected.is_empty());
}
