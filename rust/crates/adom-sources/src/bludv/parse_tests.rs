use super::*;

#[test]
fn parse_posts_basico() {
    let html = r#"
            <div class="post"><div class="title">
              <a href="https://bludv.example/filme/">Coringa (2019)</a>
            </div></div>
            <div class="post"><div class="title">
              <a href="https://bludv.example/outro/">Outro &amp; Filme</a>
            </div></div>
        "#;
    let posts = parse_posts(html);
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[0].title, "Coringa (2019)");
    assert_eq!(posts[1].title, "Outro & Filme");
}

#[test]
fn parse_download_links_respeita_secao_audio() {
    let html = r#"
            VERSÃO MKV DUAL ÁUDIO
            WEB-DL 1080p (3.39 GB - MKV)
            <a href="https://systemads.example/a">DL</a>
            VERSÃO MP4 LEGENDADO
            WEB-DL 720p (1.2 GB - MP4)
            <a href="https://videosad.example/b">DL</a>
        "#;
    let links = parse_download_links(html);
    assert_eq!(links.len(), 2);
    assert_eq!(links[0].audio, "dublado");
    assert_eq!(links[0].size.as_deref(), Some("3.39 GB"));
    assert_eq!(links[1].audio, "legendado");
}

#[test]
fn parse_download_links_inclui_gate() {
    let html = r#"
            <a href="https://systemads.example/a">DL</a>
            <a href="https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609">GATE</a>
        "#;
    let links = parse_download_links(html);
    assert_eq!(links.len(), 2);
    assert!(links[1].url.contains("/gate/go/"));
}

#[test]
fn extract_magnet_valido() {
    let body =
        r#"<a href="magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&amp;dn=x">x</a>"#;
    let m = extract_magnet(body).expect("magnet");
    assert!(m.starts_with("magnet:?"));
    assert!(!m.contains("&amp;"));
}

#[test]
fn gate_url_detectado() {
    let post = "https://bludvfilmes1.xyz/post/";
    let gate = "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609";
    assert!(is_gate_url(gate, post));
    assert!(!is_gate_url("https://systemads.example/x", post));
}
