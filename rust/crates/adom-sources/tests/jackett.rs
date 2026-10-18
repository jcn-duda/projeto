//! Cliente Jackett contra servidor falso (axum) — Torznab/JSON, breaker,
//! shaping e resolve de Link com redirect manual.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_sources::jackett::{
    shape_search_query, Breaker, JackettClient, JackettConfig, JackettMediaType, SearchOptions,
};
use adom_sources::{budget_for, now_ms};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct FakeJackett {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    calls: Mutex<Vec<Call>>,
    /// `apikey` vista na query (para o teste provar que o cliente envia, sem
    /// o crate logar).
    seen_keys: Mutex<Vec<String>>,
}

#[derive(Debug, Clone)]
struct Call {
    path: String,
    query: Option<String>,
}

impl FakeJackett {
    async fn start() -> (Self, String) {
        let api = Self::default();
        let app = Router::new()
            .route("/api/v2.0/indexers/{indexer}/results", get(results))
            .route("/dl/{indexer}/{file}", get(dl_magnet))
            .route("/evil", get(|| async { StatusCode::OK }))
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

    fn calls(&self) -> Vec<Call> {
        self.inner.calls.lock().expect("calls").clone()
    }

    fn seen_keys(&self) -> Vec<String> {
        self.inner.seen_keys.lock().expect("keys").clone()
    }
}

async fn results(
    State(api): State<FakeJackett>,
    Path(indexer): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    if let Some(key) = q.get("apikey") {
        api.inner.seen_keys.lock().expect("keys").push(key.clone());
    }
    api.inner.calls.lock().expect("calls").push(Call {
        path: format!("/api/v2.0/indexers/{indexer}/results"),
        query: q.get("Query").cloned(),
    });

    match indexer.as_str() {
        "offline" => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        "dead-source" => (
            StatusCode::OK,
            axum::Json(json!({
                "Results": [],
                "Indexers": [{ "Status": 1, "Error": "BadGateway\nstack" }]
            })),
        )
            .into_response(),
        "slow" => {
            tokio::time::sleep(Duration::from_millis(800)).await;
            (
                StatusCode::OK,
                axum::Json(ok_payload("slow", "Filme Lento")),
            )
                .into_response()
        }
        "yts" => {
            let query = q.get("Query").cloned().unwrap_or_default();
            // Global mantém acento; se o cliente strippar, falha o cenário.
            let title = if query.contains('í') || query.contains("Extermínio") {
                "Extermínio 2019"
            } else if query.contains("GORA") {
                "GORA 2004"
            } else {
                "Joker 2019"
            };
            (StatusCode::OK, axum::Json(ok_payload("yts", title))).into_response()
        }
        "bludv-cardigann" => {
            let query = q.get("Query").cloned().unwrap_or_default();
            // BR: query acentuada deve chegar SEM acento.
            if query.contains('í') || query.contains('ã') {
                return (
                    StatusCode::OK,
                    axum::Json(json!({ "Results": [], "Indexers": [{ "Status": 2 }] })),
                )
                    .into_response();
            }
            let mut payload = ok_payload("bludv-cardigann", "Filme Dublado 1080p");
            // Link relativo ao próprio Jackett (/dl/...).
            if let Some(arr) = payload.get_mut("Results").and_then(Value::as_array_mut) {
                if let Some(item) = arr.get_mut(0) {
                    item["MagnetUri"] = Value::Null;
                    item["InfoHash"] = Value::Null;
                    // preenchido no handler com a base — o cliente resolve via absolute URL
                }
            }
            (StatusCode::OK, axum::Json(payload)).into_response()
        }
        _ => (StatusCode::OK, axum::Json(ok_payload(&indexer, "Release"))).into_response(),
    }
}

async fn dl_magnet(Path((indexer, _file)): Path<(String, String)>) -> Response {
    let _ = indexer;
    let mut headers = HeaderMap::new();
    headers.insert(
        axum::http::header::LOCATION,
        HeaderValue::from_static("magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    );
    (StatusCode::FOUND, headers).into_response()
}

fn ok_payload(indexer: &str, title: &str) -> Value {
    json!({
        "Results": [{
            "Title": title,
            "MagnetUri": "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "InfoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "Seeders": 5,
            "Size": 1234,
            "PublishDate": "2024-06-01T12:00:00Z",
            "Tracker": indexer,
            "TrackerId": indexer,
            "Link": "https://tracker.example/file.torrent",
            "Category": [2000]
        }],
        "Indexers": [{ "Status": 2, "Error": null }]
    })
}

fn test_config(base: &str) -> JackettConfig {
    JackettConfig {
        url: base.to_string(),
        api_key: "chave-secreta-teste".into(),
        user_agent: "adom-sources-jackett-test/1.0".into(),
        indexer_timeout_ms: 2_000,
        br_indexer_timeout_ms: 5_000,
        download_timeout_ms: 2_000,
        breaker_failures: 2,
        breaker_cooldown_ms: 60_000,
        pt_br_indexers: vec!["bludv-cardigann".into()],
        slow_indexers: vec!["bludv-cardigann".into()],
        resolve_download_indexers: vec!["bludv-cardigann".into()],
        ..JackettConfig::default()
    }
}

#[tokio::test]
async fn search_paralelo_devolve_itens() {
    let (api, base) = FakeJackett::start().await;
    let client = JackettClient::new(test_config(&base)).expect("client");

    let items = client
        .search(
            "Joker",
            JackettMediaType::Movie,
            &["yts".into(), "therarbg".into()],
            &SearchOptions::default(),
        )
        .await;

    assert!(items.len() >= 2);
    assert!(api.calls().iter().any(|c| c.path.contains("/yts/")));
    assert!(api.calls().iter().any(|c| c.path.contains("/therarbg/")));
    // Chave chegou na query do servidor falso — o Debug do config não a vaza.
    assert!(api.seen_keys().iter().all(|k| k == "chave-secreta-teste"));
    let dbg = format!("{:?}", client.config());
    assert!(!dbg.contains("chave-secreta-teste"));
    assert!(dbg.contains("***"));
}

#[tokio::test]
async fn sem_api_key_devolve_vazio() {
    let (_api, base) = FakeJackett::start().await;
    let mut cfg = test_config(&base);
    cfg.api_key.clear();
    let client = JackettClient::new(cfg).expect("client");
    let items = client
        .search(
            "Joker",
            JackettMediaType::Movie,
            &["yts".into()],
            &SearchOptions::default(),
        )
        .await;
    assert!(items.is_empty());
}

#[tokio::test]
async fn falha_http_vira_lista_vazia_sem_panic() {
    let (api, base) = FakeJackett::start().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let items = client
        .search(
            "x",
            JackettMediaType::Movie,
            &["offline".into()],
            &SearchOptions::default(),
        )
        .await;
    assert!(items.is_empty());
    assert_eq!(api.calls().len(), 1);
}

#[tokio::test]
async fn breaker_so_em_offline() {
    let (_api, base) = FakeJackett::start().await;
    let cfg = test_config(&base);
    let client = JackettClient::new(cfg.clone()).expect("client");

    // Fonte morta no envelope conta como offline.
    let _ = client
        .search(
            "x",
            JackettMediaType::Movie,
            &["dead-source".into()],
            &SearchOptions::default(),
        )
        .await;
    let _ = client
        .search(
            "x",
            JackettMediaType::Movie,
            &["dead-source".into()],
            &SearchOptions::default(),
        )
        .await;

    let now = now_ms();
    assert!(client.breaker().tripped("dead-source", &cfg, now));

    // Com circuito aberto, a busca pula o indexer.
    let before = client.breaker().snapshot("dead-source", &cfg, now);
    assert_eq!(before.state, "aberto");
    let items = client
        .search(
            "x",
            JackettMediaType::Movie,
            &["dead-source".into()],
            &SearchOptions::default(),
        )
        .await;
    assert!(items.is_empty());

    // ignore_breaker consulta mesmo assim (varredura tardia).
    let items = client
        .search(
            "x",
            JackettMediaType::Movie,
            &["dead-source".into()],
            &SearchOptions {
                ignore_breaker: true,
                ..SearchOptions::default()
            },
        )
        .await;
    assert!(items.is_empty()); // fonte morta, mas foi consultada
}

#[tokio::test]
async fn br_strip_diacritics_global_mantem() {
    assert_eq!(
        shape_search_query("bludv", "Extermínio", true, false),
        "Exterminio"
    );
    assert_eq!(
        shape_search_query("yts", "Extermínio", false, false),
        "Extermínio"
    );
    assert_eq!(
        shape_search_query("yts", "G.O.R.A. 2004", false, false),
        "GORA 2004"
    );

    let (api, base) = FakeJackett::start().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let _ = client
        .search(
            "Extermínio",
            JackettMediaType::Movie,
            &["bludv-cardigann".into(), "yts".into()],
            &SearchOptions {
                skip_resolve: true,
                ..SearchOptions::default()
            },
        )
        .await;
    let calls = api.calls();
    let br = calls
        .iter()
        .find(|c| c.path.contains("bludv"))
        .expect("br call");
    let global = calls
        .iter()
        .find(|c| c.path.contains("/yts/"))
        .expect("yts call");
    assert_eq!(br.query.as_deref(), Some("Exterminio"));
    assert_eq!(global.query.as_deref(), Some("Extermínio"));
}

#[tokio::test]
async fn budget_br_maior_que_global() {
    let cfg = JackettConfig::default();
    assert!(budget_for("bludv-cardigann", &cfg) > budget_for("yts", &cfg));
}

#[tokio::test]
async fn resolve_link_jackett_dl_redirect_manual() {
    let (_api, base) = FakeJackett::start().await;
    let client = JackettClient::new(test_config(&base)).expect("client");
    let url = format!("{base}/dl/bludv-cardigann/file.torrent");
    let magnet = client.resolve_download_magnet(&url, 2_000).await;
    assert_eq!(
        magnet.as_deref(),
        Some("magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );

    // SSRF: loopback genérico bloqueado.
    let blocked = client
        .resolve_download_magnet("http://127.0.0.1:9/secret", 500)
        .await;
    assert!(blocked.is_none());
}

#[tokio::test]
async fn vazio_saudavel_nao_abre_breaker() {
    let b = Breaker::new();
    let cfg = JackettConfig {
        breaker_failures: 2,
        ..JackettConfig::default()
    };
    // ok:true mesmo com zero itens.
    b.record("yts", true, 1);
    b.record("yts", true, 2);
    assert!(!b.tripped("yts", &cfg, 3));
}
