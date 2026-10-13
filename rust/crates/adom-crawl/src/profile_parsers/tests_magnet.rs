use super::*;

#[test]
fn test_is_valid_magnet_uri() {
    let valid = "magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Ubuntu";
    assert!(is_valid_magnet_uri(valid));

    let valid_upper = "MAGNET:?XT=URN:BTIH:C90BA3B1E4AFF23EDDE22EB755CA4392C12BC91D";
    assert!(is_valid_magnet_uri(valid_upper));

    let base32 = "magnet:?xt=urn:btih:4w3mwyxvg4e7o7j7j2k5uvqg24xxxxxx&dn=Test";
    assert!(is_valid_magnet_uri(base32));

    let invalid_no_xt = "magnet:?dn=Test";
    assert!(!is_valid_magnet_uri(invalid_no_xt));

    let invalid_hash = "magnet:?xt=urn:btih:123";
    assert!(!is_valid_magnet_uri(invalid_hash));
}

#[test]
fn test_normalize_magnet_uri() {
    let raw = "MAGNET:?xt=urn:btih:abc1234567890123456789012345678901234567&amp;dn=Nome com espaco";
    let norm = normalize_magnet_uri(raw);
    assert!(norm.starts_with("magnet:?"));
    assert!(norm.contains("&dn=Nome%20com%20espaco"));
    assert!(!norm.contains("&amp;"));
}

#[test]
fn test_extract_magnet_variants() {
    // 1. Variável JS
    let js = r#"const DOWNLOAD_URL = "magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Test";"#;
    assert_eq!(
        extract_magnet(js),
        Some("magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Test".to_string())
    );

    // 2. data-link base64
    let magnet =
        "magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&tr=udp%3A%2F%2Ftracker.com";
    let b64 = {
        let bytes = magnet.as_bytes();
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = ((chunk[0] as u32) << 16)
                | (if chunk.len() > 1 { chunk[1] as u32 } else { 0 } << 8)
                | (if chunk.len() > 2 { chunk[2] as u32 } else { 0 });
            let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            out.push(alphabet[((n >> 18) & 63) as usize] as char);
            out.push(alphabet[((n >> 12) & 63) as usize] as char);
            out.push(if chunk.len() > 1 {
                alphabet[((n >> 6) & 63) as usize] as char
            } else {
                '='
            });
            out.push(if chunk.len() > 2 {
                alphabet[(n & 63) as usize] as char
            } else {
                '='
            });
        }
        out
    };
    let html_b64 = format!(r#"<body data-link="{b64}">"#);
    assert_eq!(extract_magnet(&html_b64), Some(magnet.to_string()));

    // 3. Link direto href
    let a = r#"<a href="magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Test">Download</a>"#;
    assert_eq!(
        extract_magnet(a),
        Some("magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Test".to_string())
    );
}

#[test]
fn test_b64_data_link_is_http() {
    let _drive = "https://drive.google.com/file/d/123/view";
    let b64 = "aHR0cHM6Ly9kcml2ZS5nb29nbGUuY29tL2ZpbGUvZC8xMjMvdmlldw==";
    let html = format!(r#"<body data-link="{b64}">"#);
    assert!(b64_data_link_is_http(&html));

    assert!(!b64_data_link_is_http("<body>sem data link</body>"));
}

#[test]
fn test_parse_post_magnets_apache() {
    let html = r###"
        <div class="download-block">
            <p class="download-versao">VERSÃO DUBLADA</p>
            <p class="download-desc">1080p DUAL ÁUDIO 5.1 <a href="#">Download</a></p>
            <a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Filme.2024.1080p">Download Torrent</a>
        </div>
        "###;
    let links = parse_post_magnets(html, None);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].quality, Some(1080));
    assert_eq!(links[0].audio.as_deref(), Some("dual"));
    assert_eq!(
        links[0].description.as_deref(),
        Some("VERSÃO DUBLADA — 1080p DUAL ÁUDIO 5.1")
    );
}

#[test]
fn test_parse_content_magnets_hdr() {
    let html = r#"
        <b>Tamanho: 4.62 GB</b>
        <div class="download-row">
            <div class="download-name">Episódio 01 - 1080p DUAL ÁUDIO</div>
            <a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=S01E01">Download</a>
        </div>
        "#;
    let links = parse_content_magnets(html, None);
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].episode, Some(1));
    assert_eq!(links[0].quality, Some(1080));
    assert_eq!(links[0].audio.as_deref(), Some("dual"));
    assert_eq!(links[0].size.as_deref(), Some("4.62 GB"));
}

#[test]
fn test_vaca_shapes() {
    let html_movie = r#"<a href="/movie-links/12345/">Links</a>"#;
    assert_eq!(
        extract_movie_links(html_movie, Some("https://vaqueirofilmes1.com")),
        Some("https://vaqueirofilmes1.com/movie-links/12345/".to_string())
    );

    let markup = r#"<div class="ss-ep-num">05</div>"#;
    assert_eq!(normalize_episode_markup(markup), "Episódio 05 ");

    assert!(is_watch_anchor(r#"class="ss-ep-btn-video""#, "Assistir"));
    assert!(is_watch_anchor("", "Veja Online"));
    assert!(!is_watch_anchor(r#"class="download-btn""#, "Baixar 1080p"));

    let batch_hero = r#"<h1 class="bl-hero-title">BATCH – Sacrifício 4ordf Temporada</h1>"#;
    assert_eq!(
        extract_batch_title(batch_hero),
        Some("Sacrifício 4ª Temporada".to_string())
    );
}
