//! Servidor falso (axum) — prova token no header, `encoded` no body, parse
//! do shape real e HTTP erro ≠ sucesso. Nunca panic no cliente.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Json;
use axum::Router;
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use super::{InternalSearchClient, DEFAULT_TIMEOUT};
use crate::internal_types::{
    CollectRequest, EffectEntry, EffectsRequest, IndexWriteRequest, MetaRequest, ReleaseEntry,
    StateRequest, TaskScope,
};

const TOKEN: &str = "tok-internal-search";
const ENCODED: &str = "eyJwIjoiamFja2V0dCJ9";

#[derive(Default)]
struct Seen {
    token: Mutex<Vec<Option<String>>>,
    bodies: Mutex<Vec<Value>>,
    paths: Mutex<Vec<String>>,
    status: Mutex<u16>,
}

async fn catch_all(State(seen): State<Arc<Seen>>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    seen.paths.lock().await.push(path.clone());
    if let Some(token) = req.headers().get("x-indexer-test-token") {
        seen.token
            .lock()
            .await
            .push(Some(token.to_str().unwrap_or("").to_string()));
    } else {
        seen.token.lock().await.push(None);
    }
    let body = axum::body::to_bytes(req.into_body(), 1 << 20)
        .await
        .unwrap_or_default();
    if let Ok(value) = serde_json::from_slice::<Value>(&body) {
        seen.bodies.lock().await.push(value);
    }

    let status = StatusCode::from_u16(*seen.status.lock().await).unwrap_or(StatusCode::OK);
    if !status.is_success() {
        return (status, Json(json!({ "ok": false, "error": "boom" }))).into_response();
    }

    let payload = match path.as_str() {
        "/internal/search/meta" => json!({
            "ok": true,
            "type": "movie",
            "id": "tt0000001",
            "imdb_id": "tt0000001",
            "season": null,
            "episode": null,
            "meta": { "name": "Filme", "year": "2024", "type": "movie" },
            "titles": { "pt": "Filme", "en": "Movie", "original": null, "br": [], "year": "2024" },
        }),
        "/internal/search/state" => json!({
            "ok": true,
            "obras": {
                "tt0000001": [{
                    "work": { "hash": "a".repeat(40), "imdb": "tt0000001" },
                    "magnet": null
                }]
            },
            "sources": {},
            "firstSeen": { "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": 1_700_000_000_000i64 }
        }),
        "/internal/search/collect" => json!({
            "ok": true,
            "task_scope": "priority",
            "query": "Filme",
            "imdb_id": "tt0000001",
            "season": null,
            "episode": null,
            "partial": true,
            "items": [{ "title": "Filme 2024", "infoHash": "a".repeat(40), "indexer": "bludv", "isBr": true }],
            "by_indexer": {
                "bludv": [{ "title": "Filme 2024", "infoHash": "a".repeat(40), "indexer": "bludv", "isBr": true }]
            },
            "live": { "failed": ["thepiratebay"], "pending": [], "empty": ["eztv"], "all": "ok" },
            "breaker": {
                "bludv": {
                    "enabled": true, "tripped": false, "state": "fechado",
                    "failStreak": 0, "failuresRequired": 3,
                    "cooldownMs": 0, "cooldownRemainingMs": 0
                }
            }
        }),
        "/internal/search/index-write" => json!({
            "ok": true,
            "recorded": 2,
            "entries": 1,
            "bank_marked": 1,
            "failed": 0
        }),
        "/internal/search/effects" => {
            return (
                StatusCode::ACCEPTED,
                Json(json!({ "ok": true, "accepted": 1, "rejected": 0 })),
            )
                .into_response();
        }
        _ => json!({ "ok": false, "error": "rota desconhecida" }),
    };
    (status, Json(payload)).into_response()
}

async fn serve(seen: Arc<Seen>) -> String {
    let app = Router::new()
        .route("/internal/search/meta", post(catch_all))
        .route("/internal/search/state", post(catch_all))
        .route("/internal/search/collect", post(catch_all))
        .route("/internal/search/index-write", post(catch_all))
        .route("/internal/search/effects", post(catch_all))
        .with_state(seen);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

fn client(base: &str) -> InternalSearchClient {
    InternalSearchClient::new(base, TOKEN, Duration::from_millis(2_000)).unwrap()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tokio::test]
async fn meta_manda_token_no_header_e_encoded_no_body() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let res = client(&base)
        .meta(&MetaRequest {
            encoded: ENCODED.into(),
            media_type: "movie".into(),
            id: "tt0000001".into(),
            include_multiwork: None,
            include_home_release: None,
        })
        .await
        .unwrap();
    assert_eq!(
        seen.token.lock().await.first().and_then(|t| t.as_deref()),
        Some(TOKEN),
        "token só no header"
    );
    let body = seen.bodies.lock().await.first().cloned().unwrap();
    assert_eq!(body["encoded"], json!(ENCODED));
    assert!(body.get("token").is_none());
    assert_eq!(body.get("apiKey"), None);
    assert!(res.ok);
    assert_eq!(res.imdb_id, "tt0000001");
    assert_eq!(res.meta.as_ref().unwrap()["name"], json!("Filme"));
}

#[tokio::test]
async fn state_parseia_shape_real() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let res = client(&base)
        .state(&StateRequest {
            encoded: ENCODED.into(),
            obra_keys: vec!["tt0000001".into()],
            hashes: vec!["a".repeat(40)],
        })
        .await
        .unwrap();
    let body = seen.bodies.lock().await.first().cloned().unwrap();
    assert_eq!(body["encoded"], json!(ENCODED));
    assert_eq!(body["obra_keys"][0], json!("tt0000001"));
    assert!(res.ok);
    assert_eq!(res.obras.get("tt0000001").map(|v| v.len()), Some(1));
    assert_eq!(
        res.first_seen.get(&"a".repeat(40)).copied(),
        Some(1_700_000_000_000)
    );
}

#[tokio::test]
async fn collect_leva_deadline_e_task_scope() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let deadline = now_ms() + 5_000;
    let res = client(&base)
        .collect(&CollectRequest {
            encoded: ENCODED.into(),
            query: "Filme".into(),
            media_type: "movie".into(),
            imdb: "tt0000001".into(),
            deadline_at: deadline,
            task_scope: Some(TaskScope::Priority),
            pt_query: Some("Filme".into()),
            season: None,
            episode: None,
            year: Some(json!(2024)),
            names: None,
            sweep_query: None,
            original_query: None,
            multi_work_query: None,
            skip_sources: Vec::new(),
        })
        .await
        .unwrap();
    let body = seen.bodies.lock().await.first().cloned().unwrap();
    assert_eq!(body["encoded"], json!(ENCODED));
    assert_eq!(
        body["type"],
        json!("movie"),
        "Node valida type=movie|series"
    );
    assert_eq!(body["task_scope"], json!("priority"));
    assert_eq!(body["deadline_at"], json!(deadline));
    assert!(res.partial);
    assert_eq!(res.task_scope, "priority");
    assert_eq!(res.items.len(), 1);
    assert!(res.by_indexer.contains_key("bludv"));
    assert_eq!(
        res.live.as_ref().map(|l| l.failed.clone()),
        Some(vec!["thepiratebay".into()])
    );
}

#[tokio::test]
async fn collect_deadline_vencido_nao_chama_rede() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let err = client(&base)
        .collect(&CollectRequest {
            encoded: ENCODED.into(),
            query: "Filme".into(),
            media_type: "movie".into(),
            imdb: "tt0000001".into(),
            deadline_at: now_ms() - 1_000,
            task_scope: None,
            pt_query: None,
            season: None,
            episode: None,
            year: None,
            names: None,
            sweep_query: None,
            original_query: None,
            multi_work_query: None,
            skip_sources: Vec::new(),
        })
        .await
        .unwrap_err();
    assert!(err.contains("deadline"), "{err}");
    assert!(seen.bodies.lock().await.is_empty());
}

#[tokio::test]
async fn index_write_e_effects_parseiam() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let c = client(&base);

    let written = c
        .index_write(&IndexWriteRequest {
            encoded: ENCODED.into(),
            releases: vec![ReleaseEntry {
                imdb: "tt0000001".into(),
                season: None,
                episode: None,
                items: vec![json!({ "title": "x" })],
                entered: None,
                survivors: None,
                source: None,
            }],
        })
        .await
        .unwrap();
    assert_eq!(written.recorded, 2);
    assert_eq!(written.bank_marked, 1);

    let mut payload = Map::new();
    payload.insert("imdbId".into(), json!("tt0000001"));
    payload.insert("type".into(), json!("movie"));
    let effects = c
        .effects(&EffectsRequest {
            encoded: ENCODED.into(),
            effects: vec![EffectEntry {
                kind: "br_probe".into(),
                payload,
            }],
        })
        .await
        .unwrap();
    assert_eq!(effects.accepted, 1);
    assert_eq!(effects.rejected, 0);

    let paths = seen.paths.lock().await.clone();
    assert!(paths.iter().any(|p| p.ends_with("/index-write")));
    assert!(paths.iter().any(|p| p.ends_with("/effects")));
}

#[tokio::test]
async fn http_erro_nao_vira_sucesso() {
    let seen = Arc::new(Seen::default());
    *seen.status.lock().await = 503;
    let base = serve(seen).await;
    let err = client(&base)
        .meta(&MetaRequest {
            encoded: ENCODED.into(),
            media_type: "movie".into(),
            id: "tt0000001".into(),
            include_multiwork: None,
            include_home_release: None,
        })
        .await
        .unwrap_err();
    assert!(
        err.contains("503") || err.contains("boom") || err.contains("HTTP"),
        "{err}"
    );
}

#[tokio::test]
async fn encoded_vazio_recusado_antes_da_rede() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let err = client(&base)
        .state(&StateRequest {
            encoded: "".into(),
            obra_keys: Vec::new(),
            hashes: Vec::new(),
        })
        .await
        .unwrap_err();
    assert!(err.contains("encoded"), "{err}");
    assert!(seen.bodies.lock().await.is_empty());
}

#[test]
fn task_scope_serializa_lowercase() {
    let mut map = BTreeMap::new();
    map.insert("task_scope", TaskScope::Nonpriority);
    let v = serde_json::to_value(map).unwrap();
    assert_eq!(v["task_scope"], json!("nonpriority"));
}

#[test]
fn new_recusa_host_nao_loopback() {
    assert!(InternalSearchClient::new("http://example.com:7100", TOKEN, DEFAULT_TIMEOUT).is_err());
    assert!(InternalSearchClient::new("http://127.0.0.1:7100", TOKEN, DEFAULT_TIMEOUT).is_ok());
}

#[test]
fn collect_timeout_nao_capa_em_default() {
    let deadline = now_ms() + 60_000;
    let budget = super::timeout_until(deadline).unwrap();
    assert!(
        budget > DEFAULT_TIMEOUT,
        "collect deve respeitar deadline longo sem min(15s): {budget:?}"
    );
    // remaining (~60s) + grace; margem larga só contra jitter de relógio
    assert!(
        budget >= Duration::from_millis(55_000),
        "budget ≈ remaining+grace: {budget:?}"
    );
}
