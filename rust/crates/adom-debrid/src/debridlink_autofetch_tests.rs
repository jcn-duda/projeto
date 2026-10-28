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
    add_status: Mutex<Option<StatusCode>>,
    remove_status: Mutex<Option<StatusCode>>,
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
            match *state.add_status.lock().unwrap() {
                Some(status) => (status, "erro de add").into_response(),
                None => Json(state.response.lock().unwrap().clone()).into_response(),
            }
        }
        "/seedbox/list" if auth == format!("Bearer {KEY}") => {
            Json(state.response.lock().unwrap().clone()).into_response()
        }
        path if path.ends_with("/remove") && auth == format!("Bearer {KEY}") => {
            match *state.remove_status.lock().unwrap() {
                Some(status) => (status, "erro de remove").into_response(),
                None => StatusCode::NO_CONTENT.into_response(),
            }
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

#[tokio::test]
async fn enqueue_propaga_o_erro_do_servico_classificado() {
    let (debrid, state) = service(json!({ "success": true, "value": { "id": "dl-42" } })).await;

    *state.add_status.lock().unwrap() = Some(StatusCode::INTERNAL_SERVER_ERROR);
    let err = debrid.enqueue_autofetch(KEY, HASH, None).await.unwrap_err();
    assert_eq!(err.kind(), "other", "5xx não vira auth/quota por acidente");

    *state.add_status.lock().unwrap() = Some(StatusCode::TOO_MANY_REQUESTS);
    let err = debrid.enqueue_autofetch(KEY, HASH, None).await.unwrap_err();
    assert_eq!(err.kind(), "rate_limit");

    *state.add_status.lock().unwrap() = Some(StatusCode::FORBIDDEN);
    let err = debrid.enqueue_autofetch(KEY, HASH, None).await.unwrap_err();
    assert_eq!(err.kind(), "auth");
}

#[tokio::test]
async fn success_false_nao_vira_foto_vazia_nem_pronto() {
    let (debrid, _) = service(json!({ "success": false, "error": "Too many tasks" })).await;
    assert_eq!(
        debrid
            .enqueue_autofetch(KEY, HASH, None)
            .await
            .unwrap_err()
            .message(),
        "Too many tasks"
    );
    assert!(
        debrid.autofetch_status(KEY).await.is_err(),
        "foto vazia condenaria hash ausente como morto"
    );
}

#[tokio::test]
async fn remove_devolve_falso_em_erro_http() {
    let (debrid, state) = service(json!({ "success": true, "value": null })).await;
    *state.remove_status.lock().unwrap() = Some(StatusCode::BAD_GATEWAY);
    assert!(!debrid.remove_autofetch(KEY, &json!("123")).await);
    assert_eq!(state.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn enqueue_descarta_magnet_de_outro_hash() {
    let (debrid, state) = service(json!({ "success": true, "value": { "id": "dl-1" } })).await;
    let foreign = "magnet:?xt=urn:btih:ffffffffffffffffffffffffffffffffffffffff";
    assert!(debrid
        .enqueue_autofetch(KEY, HASH, Some(foreign))
        .await
        .unwrap());
    let body = state.requests.lock().unwrap()[0].2.clone();
    assert!(body.contains(HASH), "monta a URI do hash pedido");
    assert!(
        !body.contains("ffffffffffffffffffffffffffffffffffffffff"),
        "nunca sobe o magnet de outra obra"
    );
}
