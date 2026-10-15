use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::Arc;

use axum::extract::Query;
use axum::http::StatusCode;
use axum::routing::get;

use super::*;
use crate::page_parser::{parse_crawl_page, parse_crawl_page_with, protector_buttons};

const POST: &str = "https://www.xfilmeshd.org/anjo-negro-2025/";
const MAGNET: &str = "magnet:?xt=urn:btih:87f3ffe0d854a457122c42ace769fb261e78c7c0&dn=Anjo.Negro.2023.1080p.WEB-DL.NACIONAL.2.0";

fn nerd_fixture() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../test/fixtures/crawl/nerdfilmes/post-anjo-negro-2025.html"
    );
    std::fs::read_to_string(path).expect("fixture do nerd")
}

/// Resolver falso na porta do Nerd (deslocada), que decide pelo hash do botão
/// (`h`): `b0` dá o magnet, `b1` é protetor sem magnet e o resto é falha de
/// rede do site.
async fn resolver_falso() -> ProtectorFollow {
    let app = axum::Router::new().route(
        "/resolve",
        get(|Query(q): Query<HashMap<String, String>>| async move {
            let h = q.get("h").cloned().unwrap_or_default();
            if h == button_id(&button(0)) {
                (StatusCode::OK, MAGNET.to_string())
            } else if h == button_id(&button(1)) {
                (StatusCode::BAD_GATEWAY, "protector_non_magnet".to_string())
            } else {
                (StatusCode::BAD_GATEWAY, "fetch_failed".to_string())
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    ProtectorFollow {
        port_offset: port - 8702,
        timeout_ms: 5_000,
        ..ProtectorFollow::default()
    }
}

fn button(i: usize) -> String {
    format!("https://www.xfilmeshd.org/link.php?id=b{i}")
}

fn buttons(n: usize) -> Vec<String> {
    (0..n).map(button).collect()
}

#[tokio::test]
async fn botao_resolvido_vira_magnet_e_terminal_e_ignorado() {
    let follow = resolver_falso().await;
    let cost = Arc::new(AtomicU32::new(0));
    let got = follow
        .resolve_buttons("nerdfilmes", POST, &buttons(2), &cost)
        .await
        .expect("um magnet basta");
    assert_eq!(got.len(), 1);
    assert_eq!(got[&buttons(2)[0]], MAGNET);
    assert_eq!(
        cost.load(Ordering::SeqCst),
        2,
        "cada botão custa uma requisição"
    );
}

#[tokio::test]
async fn falha_transitoria_so_derruba_sem_nenhum_magnet() {
    let follow = resolver_falso().await;
    let cost = Arc::new(AtomicU32::new(0));
    let mixed = follow
        .resolve_buttons("nerdfilmes", POST, &buttons(3), &cost)
        .await;
    assert_eq!(mixed.expect("um magnet basta").len(), 1);
    let terminal = follow
        .resolve_buttons("nerdfilmes", POST, &[button(1)], &cost)
        .await;
    assert!(terminal.expect("terminal fecha sem torrent").is_empty());
    let transient = follow
        .resolve_buttons("nerdfilmes", POST, &[button(2)], &cost)
        .await;
    assert!(transient.is_err(), "site fora: a página é retentada");
}

#[tokio::test]
async fn resolver_fora_do_ar_e_erro_retentavel() {
    let follow = ProtectorFollow {
        port_offset: 1, // 8703: nada escuta no teste
        timeout_ms: 2_000,
        ..ProtectorFollow::default()
    };
    let cost = Arc::new(AtomicU32::new(0));
    let r = follow
        .resolve_buttons("nerdfilmes", POST, &buttons(1), &cost)
        .await;
    assert!(r.is_err());
}

#[test]
fn site_sem_resolver_nao_segue_nada() {
    assert_eq!(
        resolver_port("bludv"),
        None,
        "portão de anúncio nunca é seguido"
    );
    assert_eq!(resolver_port("vacatorrent"), None);
    assert_eq!(resolver_port("nerdfilmes"), Some(8702));
}

#[test]
fn regua_terminal_do_ts() {
    let gate = "https://www.xfilmeshd.org/link.php?id=x";
    assert_eq!(
        classify(502, "http_400", gate, POST),
        ButtonOutcome::Terminal
    );
    assert!(matches!(
        classify(502, "http_400", "https://outro.host/link.php?id=x", POST),
        ButtonOutcome::Transient(_)
    ));
    assert_eq!(
        classify(502, "protector_link_expired", gate, POST),
        ButtonOutcome::Terminal
    );
    assert!(matches!(
        classify(502, "fetch_failed", gate, POST),
        ButtonOutcome::Transient(_)
    ));
    assert_eq!(
        classify(200, &format!(" {MAGNET}\n"), gate, POST),
        ButtonOutcome::Magnet(MAGNET.to_string())
    );
}

/// Página real do Nerd: só o `/link.php`. Sem o resolver é `no-torrent`; com o
/// magnet do resolver é `done` com a release.
#[test]
fn pagina_do_nerd_colhe_o_magnet_do_protetor() {
    let html = nerd_fixture();
    let found = protector_buttons("nerdfilmes", POST, &html);
    assert_eq!(found.len(), 1, "um botão /link.php");
    assert!(found[0].contains("/link.php?id="));
    assert_eq!(
        parse_crawl_page("nerdfilmes", "movie", POST, &html).status,
        "no-torrent"
    );
    let resolved = HashMap::from([(found[0].clone(), MAGNET.to_string())]);
    let parsed = parse_crawl_page_with("nerdfilmes", "movie", POST, &html, &resolved);
    assert_eq!(parsed.status, "done");
    assert_eq!(parsed.releases.len(), 1);
    assert!(parsed.releases[0]
        .magnet
        .contains("87f3ffe0d854a457122c42ace769fb261e78c7c0"));
    assert!(protector_buttons("bludv", POST, &html).is_empty());
}
