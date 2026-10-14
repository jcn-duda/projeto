use super::*;

#[test]
fn test_release_title_formatting() {
    let link = ResolverLink {
        url: "magnet:?...".to_string(),
        quality: Some(1080),
        source: Some("WEB-DL".to_string()),
        audio: Some("dual".to_string()),
        size: Some("2.54 GB".to_string()),
        episode: None,
        episode_last: None,
        season: None,
        real_title: None,
        description: None,
    };
    let rel = release_title("Um Dia de Sorte em Nova York", Some(2025), &link, None);
    assert_eq!(
        rel,
        "Um Dia de Sorte em Nova York (2025) [1080p WEB-DL DUAL 2.54 GB]"
    );

    // Com real_title (batch)
    let mut link_batch = link.clone();
    link_batch.real_title = Some("Sacrifício de Sangue S05".to_string());
    let rel_batch = release_title("Outer Banks", Some(2020), &link_batch, None);
    assert_eq!(
        rel_batch,
        "Sacrifício de Sangue S05 [1080p WEB-DL DUAL 2.54 GB]"
    );
}

#[test]
fn test_parse_post_links_redetorrent() {
    let html = r#"
        <table class="tbl-mv-list">
            <div class="tf theme-dark">DUBLADO</div>
            <tr class="tr-mv-list">
                <td class="td-mv-qua">1080p</td>
                <td class="td-mv-res">1080p</td>
                <td class="td-mv-idi">Português</td>
                <td class="td-mv-leg">Sem Legenda</td>
                <td class="td-mv-tam">2.1 GB</td>
                <td>
                    <a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Filme.1080p">Download</a>
                </td>
            </tr>
        </table>
        "#;
    let links = parse_post_links(html, None);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].quality, Some(1080));
    assert_eq!(links[0].audio.as_deref(), Some("dublado"));
    assert_eq!(links[0].size.as_deref(), Some("2.1 GB"));
}

#[test]
fn test_parse_download_links_vaca() {
    let html = r#"
        <div class="downloads">
            <p>Português | Inglês</p>
            <a href="https://systemtech.space/enc/go.php?id=abc">Download 1080p WEB-DL (2.54 GB)</a>
            <a class="ss-ep-btn-video" href="https://systemtech.space/enc/player.php">Veja Online</a>
        </div>
        "#;
    let links = parse_download_links(html, Some("https://vaqueirofilmes1.com"), None, None);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].url, "https://systemtech.space/enc/go.php?id=abc");
    assert_eq!(links[0].quality, Some(1080));
    assert_eq!(links[0].source.as_deref(), Some("WEB-DL"));
    assert_eq!(links[0].audio.as_deref(), Some("dual"));
    assert_eq!(links[0].size.as_deref(), Some("2.54 GB"));
}

#[test]
fn test_normalize_quality_fullhd_e_fronteiras_ascii() {
    // "FULLHD" sem espaço é a mesma faixa do JS (`FULL\s*HD`).
    assert_eq!(normalize_quality("Filme FULLHD"), Some(1080));
    assert_eq!(normalize_quality("Filme FULL HD"), Some(1080));
    assert_eq!(normalize_quality("Filme FULL  HD"), Some(1080));

    // Fronteiras ASCII: o `\b` do JS trata letra acentuada como não-palavra,
    // então o token ainda casa depois de `ç`/`Ñ` (o `\b` Unicode não casaria).
    assert_eq!(normalize_quality("AçHD"), Some(720));
    assert_eq!(normalize_quality("Ñ4K"), Some(2160));
    assert_eq!(normalize_quality("HDç"), Some(720));

    // Regressões do comportamento JS preservado.
    assert_eq!(normalize_quality("Filme 1080p"), Some(1080));
    assert_eq!(normalize_quality("Filme 2160P"), Some(2160));
    assert_eq!(normalize_quality("Filme 576p"), Some(576));
    assert_eq!(normalize_quality("Filme SD"), Some(480));
    assert_eq!(normalize_quality("Canal HDTV"), None);
    assert_eq!(normalize_quality("1080p 4K"), Some(2160));
}

#[test]
fn test_normalize_quality_kelvin_e_espacos_js() {
    // Sem `(?i)`: U+212A KELVIN não é palavra ASCII, então é fronteira como no
    // `\b` do JS (o case-fold Unicode do regex crate o incluiria na classe).
    // Valores do oráculo TS real (dist/resolvers/release-rules.js, node v22).
    assert_eq!(normalize_quality("\u{212A}2160P"), Some(2160));
    assert_eq!(normalize_quality("\u{212A}HD"), Some(720));
    assert_eq!(normalize_quality("4K\u{212A}"), Some(2160));
    // U+017F (ſ) upper-casa para 'S' e BLOQUEIA a fronteira nos dois (controle negativo).
    assert_eq!(normalize_quality("\u{017F}4K"), None);

    // Classe de espaços do JS: inclui U+FEFF, exclui U+0085 (NEL).
    assert_eq!(normalize_quality("FULL\u{FEFF}HD"), Some(1080));
    assert_eq!(normalize_quality("FULL\u{0085}HD"), Some(720));
    // Espaços comuns seguem iguais.
    assert_eq!(normalize_quality("FULL\tHD"), Some(1080));
    assert_eq!(normalize_quality("FULL\u{00A0}HD"), Some(1080));
}

#[test]
fn test_parse_download_links_decodifica_entidades_na_url() {
    // O TS decodifica as entidades do documento INTEIRO antes de parsear
    // (`decodeHtml` do `createLinkCollector`): o href sai com `&`, não `&amp;`.
    let html = r#"
        <div class="downloads">
            <p>Português | Inglês</p>
            <a href="https://systemtech.space/enc/go.php?id=abc&amp;pub=PUB_1">Download 1080p WEB-DL (2.33 GB)</a>
            <a href="https://systemtech.space/enc/go.php?id=xyz&#38;pub=PUB_2">Download 720p (1.5 GB)</a>
        </div>
    "#;
    let links = parse_download_links(html, Some("https://vacatorrent.com/x/"), None, None);
    assert_eq!(links.len(), 2);
    assert_eq!(
        links[0].url,
        "https://systemtech.space/enc/go.php?id=abc&pub=PUB_1"
    );
    assert_eq!(
        links[1].url,
        "https://systemtech.space/enc/go.php?id=xyz&pub=PUB_2"
    );
    assert!(links.iter().all(|l| !l.url.contains("&amp;")));
    assert_eq!(links[0].size.as_deref(), Some("2.33 GB"));
}

#[test]
fn test_parse_download_links_episodio_nao_panica() {
    // Regressão do panic "no group at index '1'": o `re_ep` é uma alternância e
    // cada match preenche só um grupo — `EPISÓDIO 8`→1, `S5E08`→2, `E08`→3.
    // Antes o `c[1]` direto panica nos dois últimos.
    let casos: [(&str, u32); 3] = [("EPISÓDIO 8", 8), ("S5E08", 8), ("E08", 8)];
    for (marker, esperado) in casos {
        let html = format!(
            r#"<div><a href="https://systemtech.space/enc/go.php?id=x">{marker} Download 1080p (2 GB)</a></div>"#
        );
        let links = parse_download_links(&html, Some("https://vacatorrent.com/x/"), None, None);
        assert_eq!(links.len(), 1, "{marker}");
        assert_eq!(links[0].episode, Some(esperado), "{marker}");
    }
}

#[test]
fn test_parse_download_links_episodio_ultimo_marcador_do_card() {
    // Card de temporada: `normalize_episode_markup` vira os `ss-ep-num` em
    // "Episódio NN"; o TS resolve o ESTADO do card = ÚLTIMO marcador do
    // segmento (não o primeiro). Antes o Rust dava 1 no botão PACK "VOL 1".
    let mut html = String::from("<div class=\"ss-episodes\">");
    for n in 1..=8 {
        html.push_str(&format!(
            "<div class=\"ss-ep\"><div class=\"ss-ep-num\">{n:02}</div></div>"
        ));
    }
    html.push_str(
        "<a href=\"https://systemtech.space/enc/go.php?id=st5vol1\">Stranger Things 5 VOL 1 | 1080p | Dual</a>",
    );
    html.push_str(
        "<a href=\"https://systemtech.space/enc/go.php?id=st5e08\">Stranger Things S05E08 EPISÓDIO FINAL | 1080p | Dual</a>",
    );
    html.push_str("</div>");
    let links = parse_download_links(&html, Some("https://vaca.example/x/"), None, None);
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].episode, Some(8), "card VOL 1 = último marcador");
    assert_eq!(links[1].episode, Some(8));
}
