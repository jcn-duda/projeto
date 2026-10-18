//! Cliente Prowlarr contra servidor falso (axum) — search, mapeamento,
//! fail-open e chave fora de `Debug`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_sources::{ProwlarrClient, ProwlarrConfig};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;

#[derive(Clone, Default)]
struct FakeProwlarr {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    calls: Mutex<Vec<Call>>,
    seen_keys: Mutex<Vec<String>>,
    seen_header_keys: Mutex<Vec<String>>,
    mode: Mutex<Mode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Mode {
    #[default]
    Ok,
    Http500,
    NotArray,
    Hang,
}

#[derive(Debug, Clone)]
struct Call {
    query: Option<String>,
}

impl FakeProwlarr {
    async fn start() -> (Self, String) {
        let api = Self::default();
        let app = Router::new()
            .route("/api/v1/search", get(search))
            .with_state(api.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (api, format!("http://{addr}"))
    }

    fn set_mode(&self, mode: Mode) {
        *self.inner.mode.lock().expect("mode") = mode;
    }

    fn calls(&self) -> Vec<Call> {
        self.inner.calls.lock().expect("calls").clone()
    }

    fn seen_keys(&self) -> Vec<String> {
        self.inner.seen_keys.lock().expect("keys").clone()
    }

    fn seen_header_keys(&self) -> Vec<String> {
        self.inner
            .seen_header_keys
            .lock()
            .expect("hdr")
            .clone()
    }
}

async fn search(
    State(api): State<FakeProwlarr>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(key) = q.get("apikey") {
        api.inner
            .seen_keys
            .lock()
            .expect("keys")
            .push(key.clone());
    }
    if let Some(hdr) = headers.get("X-Api-Key").and_then(|v| v.to_str().ok()) {
        api.inner
            .seen_header_keys
            .lock()
            .expect("hdr")
            .push(hdr.to_string());
    }
    api.inner.calls.lock().expect("calls").push(Call {
        query: q.get("query").cloned(),
    });

    let mode = *api.inner.mode.lock().expect("mode");
    match mode {
        Mode::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            StatusCode::OK.into_response()
        }
        Mode::Http500 => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Mode::NotArray => (StatusCode::OK, axum::Json(json!({ "oops": true }))).into_response(),
        Mode::Ok => {
            let payload = json!([
                {
                    "title": "Filme A",
                    "magnetUrl": "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "guid": "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "downloadUrl": "https://example.com/a.torrent",
                    "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "seeders": 7,
                    "size": 12345,
                    "indexer": "yts",
                    "indexerId": 42
                },
                {
                    "title": "Filme B",
                    "guid": "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc",
                    "infoHash": "cccccccccccccccccccccccccccccccccccccccc",
                    "seeders": 1,
                    "size": 99,
                    "indexerId": 9
                },
                {
                    "title": "Filme C",
                    "downloadUrl": "https://example.com/c.torrent",
                    "seeders": 0,
                    "size": 1,
                    "indexer": "tpb"
                }
            ]);
            (StatusCode::OK, axum::Json(payload)).into_response()
        }
    }
}

fn test_config(base: &str) -> ProwlarrConfig {
    ProwlarrConfig {
        url: base.to_string(),
        api_key: "chave-secreta-prowlarr".into(),
        user_agent: "adom-sources-prowlarr-test/1.0".into(),
        timeout_ms: 1_500,
        allow_private_url: true,
    }
}

#[tokio::test]
async fn sem_api_key_devolve_vazio_sem_rede() {
    let (api, base) = FakeProwlarr::start().await;
    let cfg = ProwlarrConfig {
        api_key: String::new(),
        ..test_config(&base)
    };
    let client = ProwlarrClient::new(cfg).expect("client");
    let out = client.search("Joker").await;
    assert!(out.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn query_vazia_sem_rede() {
    let (api, base) = FakeProwlarr::start().await;
    let client = ProwlarrClient::new(test_config(&base)).expect("client");
    let out = client.search("").await;
    assert!(out.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn search_monta_query_e_headers_e_mapeia() {
    let (api, base) = FakeProwlarr::start().await;
    let client = ProwlarrClient::new(test_config(&base)).expect("client");

    let items = client.search("Joker 2019").await;
    assert_eq!(items.len(), 3);

    assert_eq!(
        items[0].magnet.as_deref(),
        Some("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(items[0].tracker.as_deref(), Some("yts"));
    assert_eq!(
        items[0].info_hash.as_deref(),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(items[0].seeders, Some(7.0));
    assert_eq!(items[0].size, Some(12345.0));

    // Fallback: guid quando não há magnetUrl.
    assert_eq!(
        items[1].magnet.as_deref(),
        Some("magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc")
    );
    assert_eq!(items[1].tracker.as_deref(), Some("9"));

    // Fallback: downloadUrl.
    assert_eq!(
        items[2].magnet.as_deref(),
        Some("https://example.com/c.torrent")
    );
    assert_eq!(items[2].tracker.as_deref(), Some("tpb"));

    assert_eq!(api.calls().len(), 1);
    assert_eq!(api.calls()[0].query.as_deref(), Some("Joker 2019"));
    assert_eq!(api.seen_keys(), vec!["chave-secreta-prowlarr".to_string()]);
    assert_eq!(
        api.seen_header_keys(),
        vec!["chave-secreta-prowlarr".to_string()]
    );

    let dbg = format!("{:?}", client.config());
    assert!(!dbg.contains("chave-secreta-prowlarr"));
    assert!(dbg.contains("***"));
}

#[tokio::test]
async fn http_erro_e_corpo_nao_array_devolvem_vazio() {
    let (api, base) = FakeProwlarr::start().await;
    let client = ProwlarrClient::new(test_config(&base)).expect("client");

    api.set_mode(Mode::Http500);
    assert!(client.search("x").await.is_empty());

    api.set_mode(Mode::NotArray);
    assert!(client.search("y").await.is_empty());
}

#[tokio::test]
async fn timeout_devolve_vazio_sem_panic() {
    let (api, base) = FakeProwlarr::start().await;
    api.set_mode(Mode::Hang);
    let cfg = ProwlarrConfig {
        timeout_ms: 80,
        ..test_config(&base)
    };
    let client = ProwlarrClient::new(cfg).expect("client");
    let out = client.search("timeout").await;
    assert!(out.is_empty());
}

#[tokio::test]
async fn ssrf_barra_base_insegura() {
    let (api, _base) = FakeProwlarr::start().await;
    let cfg = ProwlarrConfig {
        url: "file:///etc/passwd".into(),
        api_key: "k".into(),
        allow_private_url: true,
        ..ProwlarrConfig::default()
    };
    let client = ProwlarrClient::new(cfg).expect("client");
    assert!(client.search("x").await.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn ssrf_barra_privado_quando_desligado() {
    let (api, base) = FakeProwlarr::start().await;
    let cfg = ProwlarrConfig {
        allow_private_url: false,
        ..test_config(&base)
    };
    let client = ProwlarrClient::new(cfg).expect("client");
    assert!(client.search("x").await.is_empty());
    assert!(api.calls().is_empty());
}
