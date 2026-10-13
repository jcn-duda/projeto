use super::*;

#[test]
fn regras_por_site_batem_com_os_profiles_ts() {
    assert_eq!(rules_for("comandotorrents").max_posts, 5);
    assert_eq!(rules_for("redetorrent").max_posts, 3);
    assert_eq!(rules_for("vacatorrent").max_posts, 3);
    assert_eq!(rules_for("apachetorrent").max_posts, 12);
    assert_eq!(rules_for("hdrtorrents").max_posts, 5);
}

#[test]
fn normaliza_como_o_create_normalize_query() {
    let comando = rules_for("comandotorrents");
    assert_eq!(normalize_query("The Boys S02E03", comando), "The Boys");
    assert_eq!(
        normalize_query("Batman: Begins 2005", comando),
        "Batman Begins 2005"
    );
    // dropYear: Rede/Vaca tiram o ano.
    assert_eq!(
        normalize_query("Batman 2005", rules_for("vacatorrent")),
        "Batman"
    );
    // boundary:false (Nerd): S01 colado também sai.
    assert_eq!(normalize_query("ShowS01", rules_for("nerdfilmes")), "Show");
    assert_eq!(normalize_query("ShowS01", comando), "ShowS01");
    // Apache/HDR mantêm a temporada e tiram acento.
    assert_eq!(
        normalize_query("Coração: S01", rules_for("hdrtorrents")),
        "Coracao S01"
    );
}

#[test]
fn temporada_pedida_e_do_post() {
    assert_eq!(requested_season("The Boys S02E03"), Some(2));
    assert_eq!(requested_season("Batman 2022"), None);
    assert!(matches_season("The Boys 2ª Temporada", Some(2)));
    assert!(!matches_season("The Boys 1ª Temporada", Some(2)));
    assert!(!matches_season("The Boys S01 Completa", Some(2)));
    // Post sem temporada no título passa (filme, pack sem marca).
    assert!(matches_season("The Boys Completa", Some(2)));
    assert!(matches_season("Qualquer S09", None));
}

#[test]
fn filtra_antes_do_corte() {
    let posts = vec![
        "Outra Coisa (2024)",
        "The Boys 1ª Temporada",
        "The Boys 3ª Temporada",
        "The Boys 2ª Temporada",
        "The Boys 2ª Temporada Dublado",
    ];
    let got = select_posts(posts, |p| p, "The Boys", Some(2), 1);
    // A 2ª temporada vem depois da 1ª e da 3ª no site e ainda assim é escolhida.
    assert_eq!(got, vec!["The Boys 2ª Temporada"]);
    let all = select_posts(
        vec!["Batman Begins", "Superman", "Batman Ninja"],
        |p| p,
        "Batman",
        None,
        5,
    );
    assert_eq!(all, vec!["Batman Begins", "Batman Ninja"]);
}
