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

#[test]
fn ano_da_query_corta_outra_obra_antes_do_corte() {
    // (a) "Duna 2021": o post da Parte 2 (2024) sai ANTES do corte — sem o
    // filtro ele seria o 1º do WordPress e comeria a vaga do filme.
    let posts = vec![
        "Duna: Parte 2 (2024) DUBLADO",
        "Planeta Duna (2021) DUBLADO",
        "Duna (2021) DUBLADO",
    ];
    let year = requested_year("Duna 2021");
    assert_eq!(year, Some(2021));
    assert_eq!(
        select_posts(posts.clone(), |p| p, "Duna 2021", None, 2),
        vec!["Duna: Parte 2 (2024) DUBLADO", "Planeta Duna (2021) DUBLADO"],
        "comportamento de hoje: o post de outra obra ocupa a vaga",
    );
    let posts = filter_year(posts, |p| p, year);
    assert_eq!(
        select_posts(posts, |p| p, "Duna 2021", None, 2),
        vec!["Planeta Duna (2021) DUBLADO", "Duna (2021) DUBLADO"],
    );
}

#[test]
fn post_sem_ano_no_titulo_passa() {
    // (b) A listagem do site pode não declarar ano: título sem ano nunca sai
    // por ano; a tolerância do padrão do projeto é ±2.
    assert!(matches_year("Duna DUBLADO", Some(2021)));
    assert!(matches_year("Duna (2021) DUBLADO", Some(2021)));
    assert!(matches_year("Duna (2023) DUBLADO", Some(2021)));
    assert!(!matches_year("Duna: Parte 2 (2024)", Some(2021)));
}

#[test]
fn serie_nao_e_condenada_pelo_ano_da_temporada() {
    // (c) O ano do post de série BR é o da TEMPORADA, não o da obra: com
    // query de filme "The Boys 2019", "4ª Temporada (2024)" é a obra certa.
    assert!(matches_year(
        "The Boys 4ª Temporada (2024) DUBLADO",
        Some(2019)
    ));
    assert!(matches_year("The Boys S04 2024 DUBLADO", Some(2019)));
    // Contraprova: SEM marca de temporada, o mesmo ano condena (outra obra).
    assert!(!matches_year("The Boys 2 (2024) DUBLADO", Some(2019)));
}

#[test]
fn query_sem_ano_preserva_o_comportamento() {
    // (d) Sem ano na query nenhum post sai: o filtro de ano é aditivo.
    assert_eq!(requested_year("The Boys S02E03"), None);
    assert_eq!(requested_year("Duna"), None);
    let posts = vec!["Duna: Parte 2 (2024)", "Duna (2021)"];
    assert_eq!(
        filter_year(posts, |p| p, None),
        vec!["Duna: Parte 2 (2024)", "Duna (2021)"]
    );
}

#[test]
fn temporada_na_query_corta_antes_do_corte() {
    // (e) "S.W.A.T. S02": a 6ª e a 5ª temporadas saem ANTES do corte (corte
    // de 2 não as alcança) e o episódio da temporada pedida entra; post sem
    // temporada no título continua passando (matchesSeason — pack sem marca
    // nunca é condenado).
    let posts = vec![
        "S.W.A.T. 6ª Temporada",
        "S.W.A.T. 5ª Temporada",
        "S.W.A.T. S02E05 DUBLADO",
        "S.W.A.T. Completa",
    ];
    let got = select_posts(posts, |p| p, "S.W.A.T.", Some(2), 2);
    assert_eq!(got, vec!["S.W.A.T. S02E05 DUBLADO", "S.W.A.T. Completa"]);
}
