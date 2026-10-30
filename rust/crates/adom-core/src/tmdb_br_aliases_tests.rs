use super::{filter_br_aliases, filter_br_aliases_typed};

const DVD: Option<&str> = Some("DVD Title");

#[test]
fn dvd_title_que_troca_uma_palavra_entra() {
    // Song of the Sea: o pt-BR do TMDB é "A Canção do Mar", os sites BR só têm
    // "A Canção do Oceano" (alternative_titles BR, tipo "DVD Title").
    let canonical = [
        Some("A Canção do Mar"),
        Some("Song of the Sea"),
        Some("Song of the Sea"),
    ];
    let out = filter_br_aliases_typed(
        &[
            (Some("A Canção do Mar"), None),
            (Some("A Canção do Oceano"), DVD),
        ],
        &canonical,
    );
    assert_eq!(out, vec!["A Canção do Oceano".to_string()]);
}

#[test]
fn sem_tipo_a_regua_continua_a_do_ts() {
    let canonical = [Some("A Canção do Mar"), Some("Song of the Sea")];
    let typed = filter_br_aliases_typed(&[(Some("A Canção do Oceano"), None)], &canonical);
    assert!(typed.is_empty());
    assert!(filter_br_aliases(&[Some("A Canção do Oceano")], &canonical).is_empty());
}

#[test]
fn dvd_title_sem_palavra_em_comum_continua_fora() {
    let canonical = [Some("Lioness"), Some("Special Ops: Lioness")];
    let out = filter_br_aliases_typed(&[(Some("Missão Secreta"), DVD)], &canonical);
    assert!(out.is_empty());
}

#[test]
fn tipo_comparado_sem_caixa_nem_espaco() {
    let canonical = [Some("A Canção do Mar")];
    let out = filter_br_aliases_typed(
        &[(Some("A Canção do Oceano"), Some("  dvd title "))],
        &canonical,
    );
    assert_eq!(out, vec!["A Canção do Oceano".to_string()]);
}

#[test]
fn outro_tipo_nao_afrouxa() {
    let canonical = [Some("A Canção do Mar")];
    let out = filter_br_aliases_typed(
        &[(Some("A Canção do Oceano"), Some("working title"))],
        &canonical,
    );
    assert!(out.is_empty());
}
