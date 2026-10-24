//! Testes do cliente BLUDV: URL de busca, guarda SSRF e chave do `raw:v1`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use crate::http::{now_ms, remaining};

use super::super::config::BludvConfig;
use super::fetch::fetch_url_allowed;
use super::{raw_cache_key, search_page_url, BludvClient};

#[test]
fn search_url_encode_query() {
    let url = search_page_url("https://bludv.example", "Chefão Parte II").unwrap();
    assert!(url.as_str().contains("s=Chef"));
    assert!(url.query().unwrap().contains("s="));
}

#[test]
fn deadline_helper_zero() {
    assert!(remaining(now_ms() - 1).is_none());
}

#[test]
fn fetch_url_allowed_publico_e_origem() {
    let cfg = BludvConfig {
        allow_private_url: true,
        base_url: "http://127.0.0.1:9".into(),
        ..BludvConfig::default()
    };
    assert!(fetch_url_allowed("https://cdn.example/systemads/a", &cfg));
    assert!(fetch_url_allowed("http://127.0.0.1:9/filme/x", &cfg));
    // Privado fora da origem da base — HTML injetado/redirect não passa.
    assert!(!fetch_url_allowed(
        "http://169.254.169.254/systemads/meta",
        &cfg
    ));
    assert!(!fetch_url_allowed("http://127.0.0.1:99/systemads/x", &cfg));
    assert!(!fetch_url_allowed("file:///etc/passwd", &cfg));
}

#[test]
fn chave_do_raw_v1_igual_ao_node() {
    assert_eq!(
        raw_cache_key("Coringa 2019", true),
        "raw:v1:bludv:d:Coringa 2019"
    );
    assert_eq!(
        raw_cache_key("Coringa 2019", false),
        "raw:v1:bludv:t:Coringa 2019"
    );
}

/// Hop privado fora da origem → Err sem GET (fail-open).
#[tokio::test]
async fn hop_inseguro_sem_get() {
    let hits = Arc::new(AtomicUsize::new(0));
    let hits_h = hits.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind trap");
    let addr = listener.local_addr().expect("addr");
    let trap_url = format!("http://{addr}/systemads/ssrf-bait");
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else {
                break;
            };
            hits_h.fetch_add(1, Ordering::SeqCst);
            let _ = sock.try_write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        }
    });

    let client = BludvClient::new(BludvConfig {
        enabled: true,
        base_url: "https://bludv.example".into(),
        max_posts: 3,
        max_links_per_post: 12,
        concurrency: 6,
        timeout_ms: 500,
        allow_private_url: false,
        ..BludvConfig::default()
    })
    .expect("client");

    let err = client
        .get_text(&trap_url, None, now_ms() + 1_000)
        .await
        .expect_err("loopback deve ser barrado");
    assert!(
        err.describe().contains("guarda SSRF"),
        "erro esperado de SSRF, obteve: {err:?}"
    );
    // Pequena folga: se o GET tivesse saído, o accept já teria incrementado.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "GET não pode ter atingido o trap"
    );
}

#[tokio::test]
async fn esquema_nao_http_sem_get() {
    let client = BludvClient::new(BludvConfig {
        enabled: true,
        base_url: "https://bludv.example".into(),
        max_posts: 3,
        max_links_per_post: 12,
        concurrency: 6,
        timeout_ms: 500,
        allow_private_url: true, // mesmo com privado liberado, file:// cai
        ..BludvConfig::default()
    })
    .expect("client");
    let err = client
        .get_text("file:///etc/passwd", None, now_ms() + 1_000)
        .await
        .expect_err("file:// deve ser barrado");
    assert!(err.describe().contains("guarda SSRF"), "obteve: {err:?}");
}
