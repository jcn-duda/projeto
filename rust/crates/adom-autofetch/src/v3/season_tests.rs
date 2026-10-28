use super::{season_fill_decision, season_fill_eligible, SeasonFill, SeasonFillSkip, SeasonGap};

#[test]
fn so_pack_compativel_com_temporada_gera_fill() {
    assert!(season_fill_eligible(
        "Some Show Season 2 Complete",
        Some(2),
        true
    ));
    assert!(!season_fill_eligible(
        "Some Show Season 2 Complete",
        Some(2),
        false
    ));
    assert!(!season_fill_eligible(
        "Some Show Season 3 Complete",
        Some(2),
        true
    ));
}

#[test]
fn temporada_nao_declarada_nunca_vira_s1() {
    // Caso de `autofetch-season-fill.test.ts`: "Temporada Completa" sem número
    // não dispara preenchimento nenhum.
    assert_eq!(
        season_fill_decision(
            true,
            "Alguma Serie Temporada Completa",
            SeasonGap { season: None },
            true,
        ),
        SeasonFill::Skip(SeasonFillSkip::NoDeclaredSeason)
    );
}

#[test]
fn pack_de_outra_temporada_nao_preenche_o_buraco() {
    assert_eq!(
        season_fill_decision(
            true,
            "Some Show Season 3 Complete",
            SeasonGap { season: Some(2) },
            true,
        ),
        SeasonFill::Skip(SeasonFillSkip::UndeclaredSeason)
    );
    assert_eq!(
        season_fill_decision(
            true,
            "Some Show Season 2 Complete",
            SeasonGap { season: Some(2) },
            true,
        ),
        SeasonFill::Fill { season: 2 }
    );
}

#[test]
fn toggle_e_tipo_de_release_vem_antes_do_match() {
    assert_eq!(
        season_fill_decision(true, "X Season 1", SeasonGap { season: Some(1) }, false),
        SeasonFill::Skip(SeasonFillSkip::NotPack)
    );
    assert_eq!(
        season_fill_decision(false, "X Season 1", SeasonGap { season: Some(1) }, true),
        SeasonFill::Skip(SeasonFillSkip::Disabled)
    );
}

#[test]
fn titulo_vazio_nao_inventa_preenchimento() {
    assert_eq!(
        season_fill_decision(true, "   ", SeasonGap { season: Some(1) }, true),
        SeasonFill::Skip(SeasonFillSkip::TitleUnproven)
    );
}
