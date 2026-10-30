//! A rota `GET /streams/trace` da admin com o recompute nativo — os três casos
//! do contrato: `found` sem ledger ⇒ resposta ganha `recompute`; `found` com
//! ledger ⇒ `recompute:null`; sem entrada ⇒ `found:false` (igual a antes, sem
//! o campo). Os testes UNITÁRIOS do outcome estão em `trace_recompute_tests.rs`.

use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use adom_core::account_scope;
use adom_search::{StreamItem, StreamsEntry};
use adom_store::StreamsStore;

use super::raw_key::raw_key_for;
use super::{boot_mem, install_for_tests, BOOT_TEST_LOCK};

const TOKEN: &str = "token-do-recompute";

fn admin_router(store: Arc<StreamsStore>) -> axum::Router {
    let cfg = crate::store_admin::AdminConfig {
        listen: crate::store_admin::DEFAULT_LISTEN.parse().unwrap(),
        token: TOKEN.to_string(),
        destructive_token: None,
    };
    crate::store_admin::router_with_ownership(
        &cfg,
        store,
        300,
        None,
        None,
        None,
        crate::ownership_admin::router(),
        None,
        None,
    )
}

async fn spawn(store: Arc<StreamsStore>) -> std::net::SocketAddr {
    let app = admin_router(store);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

async fn call(addr: std::net::SocketAddr, req: Request<Body>) -> (StatusCode, Value) {
    let client = crate::proxy::client();
    let (mut parts, body) = req.into_parts();
    let pq = parts
        .uri
        .path_and_query()
        .map(|item| item.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    parts.uri = format!("http://{addr}{pq}").parse().unwrap();
    let response = client
        .request(Request::from_parts(parts, body))
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn get(path: &str) -> Request<Body> {
    Request::builder()
        .uri(path)
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tokio::test]
// O guard do BOOT precisa atravessar os awaits (protege o boot global DURANTE
// o call); nada do outro lado pega este lock e o runtime do libtest é
// multithread — sem risco de deadlock.
#[allow(clippy::await_holding_lock)]
async fn found_sem_trace_recomputa_e_nada_vaza() {
    let _guard = BOOT_TEST_LOCK.lock().unwrap();
    let api_key = "chave-da-instalacao-do-recompute";
    let scope = account_scope(&json!(api_key));
    let shape = json!({ "debridService": "RealDebrid", "jackettIndexers": ["torrentleech"] });
    let cache_key = format!(
        "{}movie:tt777:{shape}:account:{scope}",
        adom_store::streams_prefix()
    );

    let boot = boot_mem();
    // A LISTA DO SHAPE manda: a query "Filme Sete 2020" com o indexer do shape
    // é a única lida — se a instalação caísse no default do operador (bludv),
    // o raw não seria encontrado e o teste falharia.
    let raw_key = raw_key_for(
        &boot.pt_br_indexers,
        &boot.bare_title_indexers,
        "torrentleech",
        "Filme Sete 2020",
        "movie",
    );
    boot.raw
        .set_raw(
            &raw_key,
            &json!({ "items": [{
                "title": "Filme.Sete.2020.1080p magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff",
                "infoHash": "1111111111111111111111111111111111111111",
                "seeders": 7, "indexer": "TorrentLeech",
                "_br": true, "_dubbed": true, "_quality": "1080p",
            }]}),
            3600,
            now_ms() as i64,
        )
        .unwrap();
    install_for_tests(Some(boot));

    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let entry = StreamsEntry {
        streams: vec![StreamItem {
            name: Some("1080p".into()),
            info_hash: Some("1111111111111111111111111111111111111111".into()),
            ..Default::default()
        }],
        debrid_known: Some(true),
        trace: None,
        search_meta: Some(json!({ "names": ["Filme Sete"], "year": 2020 })),
        ..Default::default()
    };
    store.set(&cache_key, &entry, 900, now_ms()).unwrap();
    let addr = spawn(store).await;

    let (status, body) = call(addr, get("/streams/trace?type=movie&id=tt777")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["found"], true);
    assert!(body["trace"].is_null());
    let recompute = &body["recompute"];
    assert_eq!(recompute["attempted"], true, "{body}");
    assert_eq!(recompute["built"], true, "{body}");
    assert_eq!(recompute["basis"], json!(["raw"]));
    assert_eq!(recompute["items"][0]["br"], true);
    assert_eq!(recompute["items"][0]["dubbed"], true);
    assert_eq!(recompute["items"][0]["quality"], "1080p");
    assert!(recompute["items"][0]["label"]
        .as_str()
        .unwrap()
        .contains("<magnet>"));
    // O MESMO contrato de vazio da rota: sem magnet cru e sem api key.
    let raw = body.to_string();
    assert!(!raw.contains("btih"), "{raw}");
    assert!(!raw.contains(api_key), "{raw}");
    // A sonda live continua com o hash (contrato antigo da rota).
    assert!(body["streams"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["infoHash"] == "1111111111111111111111111111111111111111"));
    install_for_tests(None);
}

#[tokio::test]
// Idem: o guard protege o boot durante o `call` (ver acima).
#[allow(clippy::await_holding_lock)]
async fn found_com_trace_nao_recomputa() {
    let _guard = BOOT_TEST_LOCK.lock().unwrap();
    install_for_tests(Some(boot_mem()));
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let entry = StreamsEntry {
        streams: vec![],
        debrid_known: Some(true),
        trace: Some(json!({ "startedAt": 1.0, "finishedAt": 2.0 })),
        search_meta: Some(json!({ "names": ["Filme"], "year": 2020 })),
        ..Default::default()
    };
    store
        .set(
            &format!(
                "{}movie:tt778:{{\"m\":1}}:account:abc",
                adom_store::streams_prefix()
            ),
            &entry,
            900,
            now_ms(),
        )
        .unwrap();
    let addr = spawn(store).await;

    let (status, body) = call(addr, get("/streams/trace?type=movie&id=tt778")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["found"], true);
    assert_eq!(body["trace"]["finishedAt"], 2.0);
    assert!(body["recompute"].is_null(), "{body}");
    install_for_tests(None);
}

#[tokio::test]
async fn sem_entrada_found_false_e_sem_campo_recompute() {
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let addr = spawn(store).await;

    let (status, body) = call(addr, get("/streams/trace?type=movie&id=tt000")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["found"], false);
    assert_eq!(body["source"], "rust");
    assert!(
        body.as_object().unwrap().get("recompute").is_none(),
        "{body}"
    );
}
