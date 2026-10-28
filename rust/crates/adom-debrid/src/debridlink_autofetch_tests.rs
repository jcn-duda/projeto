use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::DebridLink;

const KEY: &str = "debridlink-test-key";
const HASH: &str = "0123456789abcdef0123456789abcdef01234567";

#[derive(Default)]
struct StateData {
    requests: Mutex<Vec<(String, String, String)>>,
    response: Mutex<Value>,
}

async fn service(value: Value) -> (DebridLink, Arc<StateData>) {
    let state = Arc::new(StateData {
        response: Mutex::new(value),
        ..StateData::default()
    });
    let app = Router::new()
        .fallback(any(handle))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let _guard = crate::test_env::lock();
    let previous = std::env::var("DEBRIDLINK_API_BASE").ok();
    unsafe { std::env::set_var("DEBRIDLINK_API_BASE", format!("http://{addr}")) };
    let debrid = DebridLink::new(crate::HttpClient::new().unwrap());
    unsafe {
        match previous {
            Some(value) => std::env::set_var("DEBRIDLINK_API_BASE", value),
            None => std::env::remove_var("DEBRIDLINK_API_BASE"),
        }
    }
    drop(_guard);
    (debrid, state)
}

async fn handle(State(state): State<Arc<StateData>>, req: Request<Body>) -> Response {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let auth = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = req.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&body).into_owned();
    state
        .requests
        .lock()
        .unwrap()
        .push((method, path.clone(), body));
    match path.as_str() {
        "/seedbox/add" if auth == format!("Bearer {KEY}") => {
            Json(state.response.lock().unwrap().clone()).into_response()
        }
        "/seedbox/list" if auth == format!("Bearer {KEY}") => {
            Json(state.response.lock().unwrap().clone()).into_response()
        }
        path if path.ends_with("/remove") && auth == format!("Bearer {KEY}") => {
            StatusCode::NO_CONTENT.into_response()
        }
        _ => (StatusCode::NOT_FOUND, "unexpected request").into_response(),
    }
}

#[tokio::test]
async fn enqueue_manda_magnet_assincrono_e_retorna_se_tem_id() {
    let (debrid, state) = service(json!({ "success": true, "value": { "id": "dl-42" } })).await;
    assert!(debrid.enqueue_autofetch(KEY, HASH, None).await.unwrap());
    {
        let requests = state.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "POST");
        assert_eq!(requests[0].1, "/seedbox/add");
        assert!(requests[0].2.contains("async=true"));
        assert!(requests[0].2.contains(HASH));
    }

    let (debrid, _) = service(json!({ "success": true, "value": {} })).await;
    assert!(!debrid.enqueue_autofetch(KEY, HASH, None).await.unwrap());
}

#[tokio::test]
async fn status_classifica_ready_dead_e_downloading_sem_condenar_unknown() {
    let (debrid, _) = service(json!({ "success": true, "value": [
        { "hash": "AAAA", "downloadPercent": 100, "id": "ready-id" },
        { "infoHash": "BBBB", "status": "failed", "downloadPercent": 20, "id": 2 },
        { "hash": "CCCC", "status": "queued" },
        { "hash": "", "status": "dead" }
    ] }))
    .await;
    let status = debrid.autofetch_status(KEY).await.unwrap();
    assert_eq!(status["aaaa"].state, "ready");
    assert_eq!(status["aaaa"].id, Some(json!("ready-id")));
    assert_eq!(status["bbbb"].state, "dead");
    assert_eq!(status["cccc"].state, "downloading");
}

#[tokio::test]
async fn remove_aceita_id_seguro_e_recusa_path() {
    let (debrid, state) = service(json!({ "success": true, "value": null })).await;
    assert!(!debrid.remove_autofetch(KEY, &json!("../other")).await);
    assert!(state.requests.lock().unwrap().is_empty());
    assert!(debrid.remove_autofetch(KEY, &json!(123)).await);
    let requests = state.requests.lock().unwrap();
    assert_eq!(requests[0].0, "DELETE");
    assert_eq!(requests[0].1, "/seedbox/123/remove");
}
