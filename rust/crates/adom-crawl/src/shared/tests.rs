use super::*;

#[test]
fn test_strip_html_comments() {
    assert_eq!(
        strip_html_comments("a<!-- <h1>b</h1> -->c")
            .split_whitespace()
            .collect::<String>(),
        "ac"
    );
    assert_eq!(strip_html_comments("a<!-- b c").trim(), "a");
    assert_eq!(strip_html_comments(""), "");
}

#[test]
fn test_is_imdb_widget_reference() {
    assert!(is_imdb_widget_reference("/ref_/"));
    assert!(is_imdb_widget_reference("/list"));
    assert!(is_imdb_widget_reference("/?ref_=tt_plg_rec"));
    assert!(is_imdb_widget_reference("/?foo=1&amp;ref_=tt_plg"));

    assert!(!is_imdb_widget_reference(""));
    assert!(!is_imdb_widget_reference("/"));
    assert!(!is_imdb_widget_reference("/?ref_=nv_sr_srsg_0"));
}

#[test]
fn test_magnet_hash() {
    assert_eq!(
        magnet_hash("magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=Test"),
        Some("0123456789abcdef0123456789abcdef01234567".to_string())
    );
    assert_eq!(
        magnet_hash("magnet:?xt=urn:btih:4w3mwyxvg4e7o7j7j2k5uvqg24xxxxxx"),
        Some("4w3mwyxvg4e7o7j7j2k5uvqg24xxxxxx".to_string())
    );
    assert_eq!(magnet_hash("https://example.com/download"), None);
}

#[test]
fn test_parse_title_year() {
    let h1 = "<h1>Expresso do Amanhã (2013)</h1>";
    assert_eq!(
        parse_title_year(h1),
        TitleYear {
            title: "Expresso do Amanhã".to_string(),
            year: Some(2013)
        }
    );

    let h1_entities = "<h1>A Gangster&#8217;s Life (2020)</h1>";
    assert_eq!(
        parse_title_year(h1_entities),
        TitleYear {
            title: "A Gangster's Life".to_string(),
            year: Some(2020)
        }
    );

    let commented = "<!-- <h1>Lixo (1999)</h1> --><h1>Bancários (2020)</h1>";
    assert_eq!(
        parse_title_year(commented),
        TitleYear {
            title: "Bancários".to_string(),
            year: Some(2020)
        }
    );

    // Ano no meio não vira ano final
    let middle_year = "<h1>1ª Temporada (2022) WEB-DL</h1>";
    assert_eq!(
        parse_title_year(middle_year),
        TitleYear {
            title: "1ª Temporada (2022) WEB-DL".to_string(),
            year: None
        }
    );
}

#[test]
fn test_parse_original_title() {
    let nerd = r#"<h1 class="movie-title">7 Dogs (2026)</h1><span class="movie-original"> Título original: 7 كلاب </span>"#;
    assert_eq!(parse_original_title(nerd), Some("7 كلاب".to_string()));

    let nerd_entities =
        r#"<span class="movie-original">T&iacute;tulo original: Mike &#038; Nick</span>"#;
    assert_eq!(
        parse_original_title(nerd_entities),
        Some("Mike & Nick".to_string())
    );

    assert_eq!(
        parse_original_title("<b>Titulo Original:</b> Sick of Myself<br /> <strong>IMDb</strong>"),
        Some("Sick of Myself".to_string())
    );
    assert_eq!(
        parse_original_title("<b>Título Original</b>: Colors of Love<br /> <strong>IMDb</strong>"),
        Some("Colors of Love".to_string())
    );
    assert_eq!(
        parse_original_title("<strong>Título Original</strong>: Antibirth<br />"),
        Some("Antibirth".to_string())
    );
    assert_eq!(
        parse_original_title("<b>Titulo Original:</b> Dr. No<br /> <b>3D:</b> SIM"),
        Some("Dr. No".to_string())
    );

    // Dois nomes descartados
    assert_eq!(
        parse_original_title("<b>Titulo Original:</b> Paradox / Sha po lang: taam long<br />"),
        None
    );
    assert_eq!(
        parse_original_title("<b>Título Original:</b> Dans la brume / Just a Breath Away<br />"),
        None
    );

    // Ficha no alt da imagem cortada no rótulo seguinte
    assert_eq!(
        parse_original_title(
            r#"<img alt="Título Original: The SimpsonsLançamento: 1989Gênero: Animação" />"#
        ),
        Some("The Simpsons".to_string())
    );
    assert_eq!(
        parse_original_title(
            r#"<img alt="Título Original: Small Axe IMDb: 7,8/10 Ano de Lançamento: 2021" />"#
        ),
        Some("Small Axe".to_string())
    );
    assert_eq!(
        parse_original_title(
            r#"<img alt="Titulo Original: Peaky Blinders IMDb: 8,8/10 Gênero: Crime Lançamento S06: 2022" />"#
        ),
        Some("Peaky Blinders".to_string())
    );

    // Título que contém palavra de rótulo sem : fica inteiro
    assert_eq!(
        parse_original_title("<b>Título Original:</b> The Audio Diaries<br />"),
        Some("The Audio Diaries".to_string())
    );
    assert_eq!(
        parse_original_title("<b>Título Original:</b> The Powerpuff GirlsTítulo Brasileiro: As Meninas SuperpoderosasProdutores: Hanna-Barbera<br />"),
        Some("The Powerpuff Girls".to_string())
    );
    assert_eq!(
        parse_original_title("<b>Título Original:</b> The Piano: Lessons<br />"),
        Some("The Piano: Lessons".to_string())
    );

    // Span vence ficha
    let both = r#"<span class="movie-original">Título original: 7 كلاب</span><b>Título Original:</b> Outro<br>"#;
    assert_eq!(parse_original_title(both), Some("7 كلاب".to_string()));

    // Ausente / vazio / comentado
    assert_eq!(
        parse_original_title("<h1>Garota Exemplar (2014)</h1>"),
        None
    );
    assert_eq!(
        parse_original_title(r#"<span class="movie-original">Título original: </span>"#),
        None
    );
    assert_eq!(
        parse_original_title(r#"<!-- <span class="movie-original">Título original: X</span> -->"#),
        None
    );
}
