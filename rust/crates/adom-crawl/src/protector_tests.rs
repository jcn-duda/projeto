#[cfg(test)]
use super::*;

#[test]
fn normalize_magnet_cases() {
    assert_eq!(normalize_magnet("MAGNET:?xt=abc"), "magnet:?xt=abc");
    assert_eq!(normalize_magnet("magnet:?xt=abc"), "magnet:?xt=abc");
}
#[test]
fn is_magnet_cases() {
    assert!(is_magnet("magnet:?xt=a"));
    assert!(is_magnet("MAGNET:?xt=a"));
    assert!(!is_magnet("https://x.com"));
}
#[test]
fn meta_refresh_duplas() {
    let h = r#"<meta http-equiv="refresh" content="5;url=https://p.com/n">"#;
    assert_eq!(extract_meta_refresh(h), Some("https://p.com/n".into()));
}
#[test]
fn meta_refresh_simples() {
    assert_eq!(
        extract_meta_refresh("<meta http-equiv='refresh' content='0;url=https://x.com/g'>"),
        Some("https://x.com/g".into())
    );
}
#[test]
fn meta_refresh_sem_url() {
    assert_eq!(
        extract_meta_refresh(r#"<meta http-equiv="refresh" content="5">"#),
        None
    );
}
#[test]
fn meta_refresh_inexistente() {
    assert_eq!(extract_meta_refresh("<p>x</p>"), None);
}
#[test]
fn magnet_de_href() {
    let r = extract_magnet(r#"<a href="magnet:?xt=urn:btih:abc&dn=t">dl</a>"#).unwrap();
    assert!(r.starts_with("magnet:"));
}
#[test]
fn magnet_uppercase() {
    assert!(extract_magnet(r#"href="MAGNET:?xt=urn:btih:X""#)
        .unwrap()
        .starts_with("magnet:"));
}
#[test]
fn magnet_ausente() {
    assert_eq!(extract_magnet("<p>x</p>"), None);
}
/// O `link.php` do NerdFilmes publica `&amp;` no href: o magnet sai decodificado.
#[test]
fn magnet_com_entidades_sai_decodificado() {
    let html = r#"<a href="magnet:?xt=urn:btih:a2d1&amp;dn=Coringa&amp;tr=udp%3A%2F%2Fx">"#;
    assert_eq!(
        extract_magnet(html).unwrap(),
        "magnet:?xt=urn:btih:a2d1&dn=Coringa&tr=udp%3A%2F%2Fx"
    );
}
#[test]
fn discover_js_var() {
    let h = vec!["p.com".into()];
    let s = vec!["p.com".into()];
    assert_eq!(
        discover_next_url(
            r#"var DEST_URL = "https://p.com/go/1";"#,
            "https://s.com/p",
            &h,
            &s
        ),
        Some("https://p.com/go/1".into())
    );
}
#[test]
fn discover_host_forbidden() {
    let h = vec!["p.com".into()];
    let s = vec!["p.com".into()];
    assert_eq!(
        discover_next_url(
            r#"var DEST_URL = "https://evil.com/x";"#,
            "https://s.com/p",
            &h,
            &s
        ),
        None
    );
}
#[test]
fn discover_ignora_mesma_url() {
    let h = vec!["s.com".into()];
    let s = vec!["s.com".into()];
    assert_eq!(
        discover_next_url(
            r#"var DEST_URL = "https://s.com/p";"#,
            "https://s.com/p",
            &h,
            &s
        ),
        None
    );
}
#[test]
fn error_display() {
    assert_eq!(ProtectorError::InvalidUrl.to_string(), "URL inválida");
    assert_eq!(ProtectorError::HttpError(404).to_string(), "HTTP 404");
}
#[test]
fn protector_host_subdominio() {
    let h = vec!["p.com".into()];
    assert!(is_protector_host("www.p.com", &h));
    assert!(is_protector_host("p.com", &h));
    assert!(!is_protector_host("x.com", &h));
}
#[tokio::test]
async fn follow_magnet_direto() {
    let c = build_protector_client().unwrap();
    let h: Vec<String> = vec![];
    let s: Vec<String> = vec![];
    let opts = FollowOptions {
        url: "magnet:?xt=urn:btih:abc",
        referer: None,
        protector_hosts: &h,
        suffixes: &s,
        max_hops: 5,
        timeout: Duration::from_secs(10),
        user_agent: "test/1.0",
        client: &c,
        hooks: Default::default(),
    };
    assert_eq!(
        follow_protected_url(opts).await.unwrap(),
        "magnet:?xt=urn:btih:abc"
    );
}
#[tokio::test]
async fn follow_url_vazia() {
    let c = build_protector_client().unwrap();
    let h: Vec<String> = vec![];
    let s: Vec<String> = vec![];
    let opts = FollowOptions {
        url: "",
        referer: None,
        protector_hosts: &h,
        suffixes: &s,
        max_hops: 5,
        timeout: Duration::from_secs(10),
        user_agent: "test/1.0",
        client: &c,
        hooks: Default::default(),
    };
    assert!(matches!(
        follow_protected_url(opts).await,
        Err(ProtectorError::InvalidUrl)
    ));
}
