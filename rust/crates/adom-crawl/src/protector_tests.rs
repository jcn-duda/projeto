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

/// A cadeia com desafio só passa com o `cf_clearance` semeado, e ele não vaza
/// para outro host: é o caminho do botão `<site>/enc/go.php` do Vaca.
#[tokio::test]
async fn semente_de_cookie_vai_so_ao_host_dela() {
    use axum::{http::HeaderMap, routing::get, Router};
    let app = Router::new().route(
        "/enc/go.php",
        get(|headers: HeaderMap| async move {
            let cookie = headers
                .get("cookie")
                .and_then(|c| c.to_str().ok())
                .unwrap_or("")
                .to_string();
            if cookie == "cf_clearance=abc" {
                (
                    axum::http::StatusCode::OK,
                    "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=x",
                )
            } else {
                (axum::http::StatusCode::FORBIDDEN, "desafio")
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let url = format!("http://{addr}/enc/go.php");
    let client = build_protector_client().unwrap();
    let seguir = |host: &str| {
        let seed =
            std::collections::HashMap::from([(host.to_string(), "cf_clearance=abc".to_string())]);
        FollowOptions {
            url: &url,
            referer: None,
            protector_hosts: &[],
            suffixes: &[],
            max_hops: 2,
            timeout: Duration::from_secs(5),
            user_agent: "teste",
            client: &client,
            hooks: FollowHooks {
                cookie_jar: true,
                seed_cookies: Some(seed),
                ..Default::default()
            },
        }
    };
    let ok = follow_protected_url(seguir("127.0.0.1"))
        .await
        .expect("magnet");
    assert!(ok.starts_with("magnet:"));
    assert!(matches!(
        follow_protected_url(seguir("outro.example")).await,
        Err(ProtectorError::HttpError(403))
    ));
}
