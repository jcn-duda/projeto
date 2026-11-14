//! Temporada/Capítulo das releases latinas ("T03 C12").
//!
//! Caso medido (2026-11-14, kickasstorrents-to): "El Senor De Los Cielos 2015
//! T03 C12 … Latino" ficava sem S/E e passava como pack na busca por S10E1.

use adom_core::{matches_episode, parse_title_season_episode};

#[test]
fn temporada_capitulo_vira_s_e() {
    for (title, season, episodes) in [
        (
            "El Senor De Los Cielos 2015 T03 C12 WEB DL 1080p x264 AAC Latino URBiN4HD",
            3,
            vec![12],
        ),
        ("El Senor De Los Cielos T03C11 1080p Latino", 3, vec![11]),
        ("Serie T02 C05-C07 720p Latino", 2, vec![5, 6, 7]),
        // A forma BR de sempre não muda.
        ("Serie T01 E004 1080p", 1, vec![4]),
    ] {
        let parsed = parse_title_season_episode(title);
        assert_eq!(parsed.seasons, vec![season], "{title}");
        assert_eq!(parsed.episodes, episodes, "{title}");
    }
}

#[test]
fn capitulo_de_outra_temporada_nao_serve_ao_episodio() {
    let title = "El Senor De Los Cielos 2015 T03 C12 WEB DL 1080p x264 AAC Latino URBiN4HD";
    assert!(!matches_episode(title, Some(10), Some(1)));
    assert!(matches_episode(title, Some(3), Some(12)));
}

#[test]
fn letra_c_sem_temporada_antes_nao_vira_capitulo() {
    for title in ["Movie 2020 C1 1080p", "Show DTS C5 1080p", "Film T3C 1080p"] {
        assert!(
            parse_title_season_episode(title).episodes.is_empty(),
            "{title}"
        );
    }
}
