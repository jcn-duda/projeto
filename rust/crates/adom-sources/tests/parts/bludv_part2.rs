//! Parte 2 dos testes do BLUDV: SSRF por hop, redirect follow e `raw:v1`.
//!
//! Incluída por `#[path]` a partir de `tests/bludv.rs` (que passaria do teto
//! de 400 linhas num arquivo só).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use adom_sources::{BludvClient, BludvConfig, BludvOutcome, BludvSearchOpts, BLUDV_DEFAULT_URL};
use serde_json::json;

use super::{test_config, FakeBludv, Mode, RecordingStore, HASH};

#[tokio::test]
async fn timeout_fail_open_e_outcome() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::Hang);
    let cfg = BludvConfig {
        timeout_ms: 80,
        ..test_config(&base)
    };
    let client = BludvClient::new(cfg).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert!(out.is_empty());
    assert!(matches!(
        client
            .search_outcome("Coringa", &BludvSearchOpts::default())
            .await,
        BludvOutcome::Failed(_)
    ));
}

#[tokio::test]
async fn ssrf_barra_loopback_sem_allow_private() {
    let (api, base) = FakeBludv::start().await;
    let cfg = BludvConfig {
        allow_private_url: false,
        ..test_config(&base)
    };
    let client = BludvClient::new(cfg).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert!(out.is_empty());
    assert!(api.calls().is_empty());
    assert_eq!(
        client
            .search_outcome("Coringa", &BludvSearchOpts::default())
            .await,
        BludvOutcome::BlockedUrl
    );
}

/// Hop privado fora da origem (protetor SSRF no HTML) → skip sem GET no trap.
#[tokio::test]
async fn hop_inseguro_no_post_skip_sem_get() {
    let trap_hits = Arc::new(AtomicUsize::new(0));
    let hits_h = trap_hits.clone();
    let trap_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind trap");
    let trap_addr = trap_listener.local_addr().expect("addr");
    let evil = format!("http://{trap_addr}/systemads/evil");
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = trap_listener.accept().await else {
                break;
            };
            hits_h.fetch_add(1, Ordering::SeqCst);
            let _ = sock.try_write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        }
    });

    let (api, base) = FakeBludv::start().await;
    api.set_extra_link(Some(evil));
    // allow_private libera só a origem da base — o trap (outra porta) cai.
    let client = BludvClient::new(test_config(&base)).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert_eq!(out.len(), 2, "links da mesma origem seguem: {out:?}");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        trap_hits.load(Ordering::SeqCst),
        0,
        "hop SSRF não pode ter recebido GET"
    );
}

/// `redirect: follow` do TS: o 302 do protetor é seguido e o magnet do alvo
/// entra na lista.
#[tokio::test]
async fn redirect_follow_segue_hop() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::RedirectHop);
    let client = BludvClient::new(test_config(&base)).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert_eq!(out.len(), 2, "follow deve produzir magnet: {out:?}");
    assert!(api.calls().iter().any(|c| c.contains("redirect-target")));
}

/// Redirect para privado FORA da origem: a guarda SSRF roda em cada hop e o
/// alvo nunca recebe GET.
#[tokio::test]
async fn redirect_para_privado_fora_da_origem_nao_segue() {
    let trap_hits = Arc::new(AtomicUsize::new(0));
    let hits_h = trap_hits.clone();
    let trap_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind trap");
    let trap_addr = trap_listener.local_addr().expect("addr");
    let target = format!("http://{trap_addr}/systemads/redirected");
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = trap_listener.accept().await else {
                break;
            };
            hits_h.fetch_add(1, Ordering::SeqCst);
            let _ = sock.try_write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        }
    });

    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::RedirectSsrf);
    api.set_redirect_to(Some(target));
    let client = BludvClient::new(test_config(&base)).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert!(out.is_empty(), "redirect privado não pode render magnet");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        trap_hits.load(Ordering::SeqCst),
        0,
        "redirect SSRF não pode ter recebido GET"
    );
}

/// `raw:v1`: o caminho vivo grava, o segundo scrape lê o cache e não vai à
/// rede de novo; a chave carrega a flag de dublado como no Node.
#[tokio::test]
async fn raw_v1_vivo_grava_e_le() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::Clean);
    let store = Arc::new(RecordingStore::default());
    let client = BludvClient::new(test_config(&base))
        .expect("client")
        .with_raw_store(store.clone());

    let first = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert_eq!(first.len(), 2);
    assert_eq!(store.sets(), 1);
    assert_eq!(
        store.keys(),
        vec!["raw:v1:bludv:t:Coringa".to_string()],
        "chave = raw:v1:bludv:<d|t>:<query>"
    );

    let calls = api.calls().len();
    let second = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert_eq!(second, first, "cache devolve os mesmos itens");
    assert_eq!(store.gets(), 2, "1ª busca: miss; 2ª: hit do raw:v1");
    assert_eq!(api.calls().len(), calls, "hit do raw:v1 não vai à rede");

    // Flag de dublado muda a chave (o scrape filtra legendado ANTES de gravar).
    let dubbed = client
        .search("Coringa", &BludvSearchOpts { dubbed_only: true })
        .await;
    assert_eq!(dubbed.len(), 1);
    assert!(store
        .keys()
        .iter()
        .any(|key| key == "raw:v1:bludv:d:Coringa"));
}

/// Post com portão de anúncio não vira cache cru de longa duração
/// (`incomplete` no brief do Node).
#[tokio::test]
async fn gate_nao_cacheia_raw_v1() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::GateOnly);
    let store = Arc::new(RecordingStore::default());
    let client = BludvClient::new(test_config(&base))
        .expect("client")
        .with_raw_store(store.clone());
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert!(out.is_empty());
    assert_eq!(store.sets(), 0, "lote incompleto (gate) não grava");
}

#[tokio::test]
async fn query_vazia_sem_rede() {
    let (api, base) = FakeBludv::start().await;
    let client = BludvClient::new(test_config(&base)).expect("client");
    assert!(client
        .search("   ", &BludvSearchOpts::default())
        .await
        .is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn default_desligado() {
    let cfg = BludvConfig::default();
    assert!(!cfg.enabled);
    assert_eq!(cfg.base_url, BLUDV_DEFAULT_URL);
    assert!(cfg.raw_cache_enabled());
}

#[test]
fn cache_de_obras_serializa_no_formato_do_node() {
    // Guarda o contrato do valor (`{items:[…]}` em camelCase) usado pelo
    // gateway e pelo Node.
    let item = adom_sources::BludvRawItem {
        title: "Filme 2024 [1080p WEB-DL DUBLADO]".into(),
        magnet: format!("magnet:?xt=urn:btih:{HASH}&dn=x"),
        seeders: 1.0,
        size: Some(1_000.0),
        tracker: "BLUDV".into(),
        audio: "dublado".into(),
        is_br: true,
    };
    let value = json!({ "items": [item] });
    assert_eq!(value["items"][0]["tracker"], json!("BLUDV"));
    assert_eq!(value["items"][0]["isBr"], json!(true));
    assert_eq!(value["items"][0]["audio"], json!("dublado"));
}
