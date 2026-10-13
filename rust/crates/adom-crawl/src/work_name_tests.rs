#[cfg(test)]
use super::*;

fn h1(text: &str) -> String {
    format!(r#"<h1 class="entry-title">{text}</h1>"#)
}

fn name_of(text: &str) -> (String, Option<u32>) {
    let SplitParenYear { rest, year } = split_paren_year(&h1_text(&h1(text)));
    (clean_work_name(&rest), year)
}

#[test]
fn test_sobras_de_vitrine_medidas() {
    let cases: &[(&str, &str, Option<u32>)] = &[
            (
                "Curvas da Vida &#8211; GDRIVE (2012) BluRay 1080p Dual Áudio",
                "Curvas da Vida",
                Some(2012),
            ),
            (
                "Em Meus Sonhos Torrent (2016) BluRay 720p e 1080p Dual Áudio",
                "Em Meus Sonhos",
                Some(2016),
            ),
            (
                "Do Not Reply Torrent (2020) WEB-DL 720p e 1080p Legendado",
                "Do Not Reply",
                Some(2020),
            ),
            (
                "O Regresso (2015) WEB-DL 720p Legendado / Legendas Fixas em Português",
                "O Regresso",
                Some(2015),
            ),
            (
                "Eek The Cat Torrent Dublado 8 Episódios (1992)",
                "Eek The Cat",
                Some(1992),
            ),
            (
                "Quebrando Regras Torrent &#8211; Bluray 720p Dual Aúdio (2008)",
                "Quebrando Regras",
                Some(2008),
            ),
            (
                "007 Contra o Satânico Dr. No &#8211; BluRay 3D HSBS (1962) Dual &#8211; Download Torrent",
                "007 Contra o Satânico Dr. No",
                Some(1962),
            ),
            (
                "À Procura da Liberdade Torrent (2016) DVD-R Oficial Dual Áudio",
                "À Procura da Liberdade",
                Some(2016),
            ),
            (
                "À Procura da Liberdade Torrent (2016) DVD R Oficial Dual Áudio",
                "À Procura da Liberdade",
                Some(2016),
            ),
            (
                "The Big Bang Theory 9° Temporada Torrent (2015) HDTV Legendado",
                "The Big Bang Theory",
                Some(2015),
            ),
        ];

    for &(raw, title, year) in cases {
        assert_eq!(name_of(raw), (title.to_string(), year), "falha em {raw}");
    }
}

#[test]
fn test_o_que_a_regua_nao_pode_comer() {
    assert_eq!(
        name_of("Temporada de Caça (2006) Dublado").0,
        "Temporada de Caça"
    );
    assert_eq!(
        name_of("Temporada de Caça 2 (2008) Dublado").0,
        "Temporada de Caça 2"
    );
    assert_eq!(
        name_of("Temporada de Patos (2004) Legendado").0,
        "Temporada de Patos"
    );
    assert_eq!(name_of("Pit Stop Temporada Completa (2021)").0, "Pit Stop");
    assert_eq!(
        name_of("The Office Todas as Temporadas Completas").0,
        "The Office"
    );
    assert_eq!(
        name_of("O Caçador 1ª Temporada Completa Mini Série (2014) Dublado").0,
        "O Caçador"
    );

    assert_eq!(
        name_of("Sea Rex 3D: Journey to a Prehistoric World (2010) Dublado 1080p").0,
        "Sea Rex 3D: Journey to a Prehistoric World"
    );
    assert_eq!(name_of("Avatar 3D SBS (2009) BluRay 1080p").0, "Avatar");

    assert_eq!(
        name_of("O Oficial e o Espião (2019) Dublado").0,
        "O Oficial e o Espião"
    );
    assert_eq!(
        name_of("Deuses e Monstros (1998) Dublado").0,
        "Deuses e Monstros"
    );
    assert_eq!(
        name_of("Star Wars: Episódio I (1999) BluRay").0,
        "Star Wars: Episódio I"
    );

    assert_eq!(
        name_of("Blade Runner 2049 Torrent"),
        ("Blade Runner 2049".to_string(), None)
    );
}

#[test]
fn test_lista_ordinais_agrega_temporadas() {
    let cases: &[(&str, &str, Option<u32>)] = &[
        (
            "Superman &amp; Lois 1ª e 2ª Temporada Torrent (2021)",
            "Superman & Lois",
            Some(2021),
        ),
        (
            "Carmen Sandiego 1ª 2ª 3ª 4ª Temporada (2019)",
            "Carmen Sandiego",
            Some(2019),
        ),
        (
            "The Sinner 1ª, 2ª e 3ª Temporada (2017)",
            "The Sinner",
            Some(2017),
        ),
        (
            "Community (2009) 1ª 2ª 3ª 4ª 5ª 6ª Temporada",
            "Community",
            Some(2009),
        ),
        (
            "Brooklyn Nine-Nine 1ª 2ª 3ª 4ª 5ª 6ª 7ª 8ª Temporada (2013)",
            "Brooklyn Nine Nine",
            Some(2013),
        ),
        (
            "Seven 1ª 2ª 3ª Temporada Completa (1995)",
            "Seven",
            Some(1995),
        ),
        (
            "Gravity Falls 7° Temporada (2012)",
            "Gravity Falls",
            Some(2012),
        ),
        (
            "Lanternas Verdes 1ª Temporada (2021)",
            "Lanternas Verdes",
            Some(2021),
        ),
        (
            "The Walking Dead 1ª à 11ª Temporada (2021)",
            "The Walking Dead",
            Some(2021),
        ),
        (
            "Os Simpsons 1ª à 33ª Temporada (2021)",
            "Os Simpsons",
            Some(2021),
        ),
        ("Vikings 1ª a 6ª Temporada (2013)", "Vikings", Some(2013)),
        ("Blood TVRip (2006)", "Blood", Some(2006)),
        (
            "Animais Fantásticos e Onde Habitam HDRip (2017)",
            "Animais Fantásticos e Onde Habitam",
            Some(2017),
        ),
        (
            "A Very English Scandal Minissérie (2018)",
            "A Very English Scandal",
            Some(2018),
        ),
        (
            "Mr. Robot 1080p x265 HEVC DTS (2015)",
            "Mr. Robot",
            Some(2015),
        ),
        ("Dexter 1ª á 8ª Temporada (2006)", "Dexter", Some(2006)),
        (
            "Elite Histórias Breves Todas Temporadas Torrent (2021) WEB-DL 720p/1080p Dublado",
            "Elite Histórias Breves",
            Some(2021),
        ),
        (
            "Stranger Things: Histórias de 85 1ª e 2ª Temporada (2026)",
            "Stranger Things: Histórias de 85",
            Some(2026),
        ),
        ("Agente 007 1ª Temporada (2015)", "Agente 007", Some(2015)),
    ];

    for &(raw, title, year) in cases {
        assert_eq!(name_of(raw), (title.to_string(), year), "falha em {raw}");
    }
}

#[test]
fn test_ampersand_e_conectores() {
    assert_eq!(
        name_of("Batman &amp; Robin 1080p Dublado").0,
        "Batman & Robin"
    );
    assert_eq!(
        name_of("Fast &amp; Furious 7 Múltiplos Torrent (2015) BluRay 1080p Dual Áudio").0,
        "Fast & Furious 7 Múltiplos"
    );
    assert_eq!(
        name_of("Plano de fuga Dublado &amp; Legendado 1080p").0,
        "Plano de fuga"
    );
    assert_eq!(
        name_of("Filme Qualquer 720p &amp; 1080p Dublado").0,
        "Filme Qualquer"
    );

    assert_eq!(name_of("Deadpool – Rip").0, "Deadpool");
    assert_eq!(name_of("Noturno / FULL").0, "Noturno");
    assert_eq!(name_of("Introspectum Motel e").0, "Introspectum Motel");
    assert_eq!(name_of("Deuses e Monstros").0, "Deuses e Monstros");
    assert_eq!(
        name_of("Sea Rex 3D: Journey to a Prehistoric World").0,
        "Sea Rex 3D: Journey to a Prehistoric World"
    );
    assert_eq!(
        name_of("Chainsaw Man – O Filme: Arco da Reze").0,
        "Chainsaw Man O Filme: Arco da Reze"
    );
}

#[test]
fn test_ficha_year_e_read_work_title() {
    let cores = format!(
            "{}<b>Título Original</b>: Colors of Love<br /> <strong>Lançamento</strong>: <a href=\"https://x/2021\">2021</a><br />",
            h1("As Cores do Amor Torrent &#8211; WEB-DL 1080p Dual Áudio")
        );
    let res_cores = read_work_title(&cores);
    assert_eq!(res_cores.year, Some(2021));
    assert_eq!(res_cores.title, "As Cores do Amor");

    assert_eq!(
        ficha_year("<b>Ano de Lançamento:</b> 2017 (Brasil)<br />"),
        Some(2017)
    );
    assert_eq!(
        ficha_year("<b>Lan&ccedil;amento:</b> 1962<br />"),
        Some(1962)
    );

    let paradox = format!(
            "{}<b>Lançamento:</b> 2018<br />",
            h1("Comando Final 3 &#8211; Paradox 2018 Torrent &#8211; Dublado / Dual Áudio BluRay 720p | 1080p &#8211; Download")
        );
    let res_paradox = read_work_title(&paradox);
    assert_eq!(res_paradox.title, "Comando Final 3 Paradox");
    assert_eq!(res_paradox.year, Some(2018));

    assert_eq!(
        read_work_title(&h1("Blade Runner 2049 (2017) Dublado")).title,
        "Blade Runner 2049"
    );
    assert_eq!(read_work_title(&h1("1984 (1984) Dublado")).title, "1984");

    let boneca = format!(
        "{}<span style=\"color: black;\"><strong><em>Lançamento:</em></strong> 2022</span><br>",
        h1("Boneca Russa 2ª Temporada Torrent &#8211; WEB-DL 720p/1080p Dual Áudio")
    );
    let res_boneca = read_work_title(&boneca);
    assert_eq!(res_boneca.title, "Boneca Russa");
    assert_eq!(res_boneca.year, Some(2022));

    assert_eq!(ficha_year("<i>Lançamento:</i> 2019"), Some(2019));
    assert_eq!(
        ficha_year(
            r#"<option class="level-0" value="158">Lançamento</option><option class="level-1" value="23945">&nbsp;&nbsp;&nbsp;1918</option>"#
        ),
        None
    );

    let homeland = format!(
        "{}<strong><em>Lançamento:</em></strong> 2011<br>",
        h1("Homeland: Segurança Nacional 1ª á 8ª Temporada (2011-2020) WEB-DL 1080p Dual Áudio")
    );
    let res_homeland = read_work_title(&homeland);
    assert_eq!(res_homeland.year, Some(2011));
    assert!(res_homeland.title.starts_with("Homeland: Segurança"));
    assert!(!res_homeland.title.chars().any(|c| c.is_ascii_digit()));
    assert!(!res_homeland.title.contains('á'));
    assert!(!res_homeland.title.contains('(') && !res_homeland.title.contains(')'));

    assert_eq!(
        read_work_title(&format!(
            "{}<b>Lançamento:</b> 2008",
            h1("Juno (2007) Dublado")
        ))
        .year,
        Some(2007)
    );
    assert_eq!(read_work_title(&h1("Sem Ano Torrent")).year, None);
    assert_eq!(ficha_year("<p>O lançamento do filme foi adiado.</p>"), None);
}
