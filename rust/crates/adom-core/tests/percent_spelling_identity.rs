//! Equivalência contextual de grafia `%` -> `percent` na identidade de nome
//! numérico ("3%").
//!
//! Medido nas APIs reais: `names:["3%"]` rejeitava
//! `3.Percent.S01E01`, `3 Percent S01` e o pack
//! `3 Percent (2016) S01-S04 (1080p NF WEB-DL x265)`, enquanto
//! `names:["3%","3 Percent"]` aceitava. A grafia só vale quando o NOME carrega
//! o símbolo e só na posição que o símbolo ocupa no run; `percent`/`cento` NÃO
//! entram em ruído global, `por cento` não é equivalência e "24 Percent" segue
//! rejeitado para "24".
//!
//! Os testes de pipeline rodam na ORDEM real (`stream-builder-pipeline`):
//! `filter_relevant_raw` SEM season/episode, depois `filter_series_episode`.

use adom_core::{
    filter_relevant_raw, filter_series_episode, matches_short_name_identity, short_name_identity,
    title_tokens, EpisodeFilterItem, RelevanceItem, RelevanceQuery, RelevanceRejectReason,
    RelevanceSettings, SeriesEpisodeRejectReason, ShortNameIdentity,
};

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn settings() -> RelevanceSettings {
    RelevanceSettings {
        now_ms: 0,
        pre_home_release_cut: false,
        pre_home_release_margin_ms: 0,
        title_precision_tail_cut: true,
    }
}

/// Query de título, como o pipeline chama: sem season/episode.
fn title_query<'a>(names: &'a [String], year: &'a str) -> RelevanceQuery<'a> {
    RelevanceQuery {
        names,
        year,
        alt_year: None,
        is_series: true,
        season: None,
        episode: None,
        multi_work_root: None,
        home_release_at: None,
    }
}

fn relevant_item(title: &str) -> RelevanceItem {
    RelevanceItem {
        title: Some(title.to_string()),
        ..Default::default()
    }
}

fn episode_item(title: &str) -> EpisodeFilterItem<'_> {
    EpisodeFilterItem {
        title: Some(title),
        title_pascal: None,
        magnet: None,
        magnet_uri: None,
        guid: None,
        info_hash: None,
        from_account: false,
        is_br: false,
    }
}

fn identity_keeps(name: &str, title: &str) -> bool {
    matches_short_name_identity(title, &short_name_identity(name), None, "")
}

/// Ordem do pipeline: título (sem S/E) e depois episódio (com S/E).
fn pipeline_keeps(names: &[String], title: &str, season: i64, episode: i64) -> bool {
    let relevant = filter_relevant_raw(
        &[relevant_item(title)],
        &title_query(names, "2016"),
        &settings(),
    );
    if relevant.kept != [0] {
        return false;
    }
    let universe = names
        .iter()
        .flat_map(|n| title_tokens(n))
        .collect::<Vec<_>>();
    let eps = filter_series_episode(
        &[episode_item(title)],
        season,
        episode,
        &universe,
        names,
        false,
        &[],
        true,
    );
    eps.kept == [0]
}

#[test]
fn identidade_aceita_percent_so_quando_o_nome_tem_o_simbolo() {
    let check = short_name_identity("3%");
    match &check {
        ShortNameIdentity::Prefix {
            want,
            run,
            percent_spelling,
        } => {
            assert_eq!(want, "3");
            assert_eq!(run, &vec!["3".to_string()]);
            assert!(percent_spelling, "3% precisa carregar a equivalência");
        }
        other => panic!("3% deveria ser prefix: {other:?}"),
    }

    for title in [
        "3.Percent.S01E01.1080p.WEB-DL",
        "3 Percent S01",
        "3 Percent (2016) S01-S04 (1080p NF WEB-DL x265)",
        "3 % S01E01 1080p",
        "3 Percent Temporada 1 Completa",
    ] {
        assert!(
            matches_short_name_identity(title, &check, None, ""),
            "legítimo: {title}"
        );
    }

    for title in [
        "3 Body Problem S01 1080p",
        "3 Body Problem S01E01 1080p",
        "3 Percent Body Problem S01E01 1080p",
        "3 Percentual S01E01 1080p",
        "3 Por Cento S01E01 1080p",
        "100 Percent S01E01 1080p",
        "20 Percent S01E01 1080p",
        "100PercentWolf S01E01 1080p",
        "3PercentBodyProblem S01E01 1080p",
    ] {
        assert!(
            !matches_short_name_identity(title, &check, None, ""),
            "homônimo/grafia estranha: {title}"
        );
    }

    // `percent` não é ruído global: 24 continua exigindo 24 e não aceita a
    // palavra como se fosse o numeral.
    let vinte_e_quatro = short_name_identity("24");
    assert!(matches!(
        vinte_e_quatro,
        ShortNameIdentity::Prefix {
            percent_spelling: false,
            ..
        }
    ));
    assert!(!matches_short_name_identity(
        "24 Percent S01E01",
        &vinte_e_quatro,
        None,
        ""
    ));
}

#[test]
fn dn_alternativo_carrega_a_grafia_sem_afrouxar_o_titulo() {
    let check = short_name_identity("3%");
    // O magnet real nomeia a obra; o título sozinho contradiz.
    assert!(matches_short_name_identity(
        "3 Body Problem S01E01",
        &check,
        None,
        "3.Percent.S01E01.1080p.WEB-DL"
    ));
    assert!(!matches_short_name_identity(
        "3 Body Problem S01E01",
        &check,
        None,
        "3 Body Problem S01E01"
    ));
    // A grafia portuguesa não ganhou equivalência.
    assert!(!matches_short_name_identity(
        "3 Body Problem S01E01",
        &check,
        None,
        "3 Por Cento S01E01"
    ));
}

#[test]
fn pipeline_relevancia_e_episodio_na_ordem_real() {
    let nomes = names(&["3%"]);
    for title in [
        "3.Percent.S01E01.1080p.WEB-DL",
        "3 Percent S01",
        "3 Percent (2016) S01-S04 (1080p NF WEB-DL x265)",
        "3 % S01E01 1080p",
    ] {
        assert!(
            pipeline_keeps(&nomes, title, 1, 1),
            "pipeline legítimo: {title}"
        );
    }
    for title in [
        "3 Body Problem S01E01 1080p",
        "3 Percent Body Problem S01E01 1080p",
        "3 Percentual S01E01 1080p",
        "3 Por Cento S01E01 1080p",
        "100 Percent S01E01 1080p",
        "20 Percent S01E01 1080p",
        "100PercentWolf S01E01 1080p",
        "3PercentBodyProblem S01E01 1080p",
    ] {
        assert!(
            !pipeline_keeps(&nomes, title, 1, 1),
            "pipeline homônimo: {title}"
        );
    }

    // A relevância NÃO recebe season/episode: o mesmo release de obra certa
    // passa nela e cai só no filtro de episódio.
    let relevant = filter_relevant_raw(
        &[relevant_item("3.Percent.S01E02.1080p")],
        &title_query(&nomes, "2016"),
        &settings(),
    );
    assert_eq!(relevant.kept, [0]);
    let universe = title_tokens("3%");
    let eps = filter_series_episode(
        &[episode_item("3.Percent.S01E02.1080p")],
        1,
        1,
        &universe,
        &nomes,
        false,
        &[],
        true,
    );
    assert_eq!(
        eps.rejected,
        [(0, SeriesEpisodeRejectReason::Episode)],
        "obra certa, episódio errado: quem corta é a etapa de episódio"
    );

    // O motivo do homônimo é título, não episódio.
    let body = filter_relevant_raw(
        &[relevant_item("3 Body Problem S01E01 1080p")],
        &title_query(&nomes, "2016"),
        &settings(),
    );
    assert_eq!(body.rejected, [(0, RelevanceRejectReason::Title)]);
}

#[test]
fn alias_textual_nao_perde_a_obra_correta() {
    // O caminho medido que já funcionava: nomes com alias textual passam. A
    // equivalência nova não pode transformar isso em rejeição.
    for nomes in [names(&["3%"]), names(&["3%", "3 Percent"])] {
        for title in [
            "3.Percent.S01E01.1080p.WEB-DL",
            "3 Percent (2016) S01-S04 (1080p NF WEB-DL x265)",
        ] {
            assert!(pipeline_keeps(&nomes, title, 1, 1), "{nomes:?}: {title}");
        }
        assert!(
            !pipeline_keeps(&nomes, "3 Body Problem S01E01 1080p", 1, 1),
            "{nomes:?}: 3 Body Problem"
        );
    }
}

#[test]
fn multiplicidade_ordem_e_nomes_antigos_seguem_intactos() {
    let nove = short_name_identity("9-1-1");
    assert!(identity_keeps("9-1-1", "9-1-1 S01E01 1080p"));
    assert!(!identity_keeps("9-1-1", "9 1 S01E01 1080p"));
    assert!(matches!(
        nove,
        ShortNameIdentity::Prefix {
            percent_spelling: false,
            ..
        }
    ));

    let onze = short_name_identity("11.22.63");
    assert!(identity_keeps("11.22.63", "11.22.63 S01E01 1080p"));
    assert!(!identity_keeps("11.22.63", "11 22 64 S01E01 1080p"));
    assert!(matches!(
        onze,
        ShortNameIdentity::Prefix {
            percent_spelling: false,
            ..
        }
    ));

    for name in ["V", "It", "Up", "光環"] {
        assert_eq!(
            short_name_identity(name),
            ShortNameIdentity::NoToken,
            "{name}"
        );
    }
}
