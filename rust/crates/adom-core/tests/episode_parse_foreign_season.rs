//! Temporada escrita em italiano, francês ou alemão nos trackers globais.
//!
//! Caso medido (2026-10-19, TheRARBG): "Naruto 2002 Stagione 03 COMPLETA …"
//! ficava sem temporada e o pack da T3 passava na busca por S01E01.

use adom_core::parse_title_season_episode;

#[test]
fn stagione_saison_staffel_viram_temporada() {
    for (title, season) in [
        (
            "Naruto 2002 Stagione 03 COMPLETA 1080p H265 ITA AC3 EAC3 JPN EAC3 Sub Ita AMZN WEB DL",
            3,
        ),
        ("Dark Staffel 2 German 1080p WEB", 2),
        ("Lupin Saison 1 FRENCH 1080p WEB", 1),
    ] {
        assert_eq!(
            parse_title_season_episode(title).seasons,
            vec![season],
            "{title}"
        );
    }
}

#[test]
fn palavra_sem_numero_nao_inventa_temporada() {
    // Sem número colado na palavra, nada muda: o nome da obra pode conter
    // "saison"/"staffel" como palavra comum.
    assert!(parse_title_season_episode("Staffel Movie 2020 1080p")
        .seasons
        .is_empty());
}
