use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use adom_core::PlayHint;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::{Json, Router};
use http_body_util::BodyExt;
use serde_json::json;
use tokio::net::TcpListener;

use super::{
    uncertain_key, RdAutofetchError, RdUncertainIntent, RdUncertainStore, RdWriteKind,
    RealDebridAutofetch,
};
use crate::rd_gate_executor::RdGateExecutor;
use crate::rd_scheduler::RdSchedulerConfig;
use crate::realdebrid::RealDebrid;
use crate::HttpClient;

const KEY: &str = "rd-autofetch-fake-key";
const HASH: &str = "0123456789abcdef0123456789abcdef01234567";

#[derive(Default)]
struct FakeStore {
    intents: Mutex<HashMap<String, RdUncertainIntent>>,
    owned: Mutex<HashSet<(String, String, String)>>,
    fail_write: Mutex<bool>,
    fail_read: Mutex<bool>,
    fail_clear: Mutex<bool>,
    /// Simula perder a corrida: outro escritor já gravou o intent.
    reject_put: Mutex<bool>,
}

impl FakeStore {
    fn seed_owned(&self, account: &str, hash: &str, id: &str) {
        self.owned
            .lock()
            .unwrap()
            .insert((account.to_string(), hash.to_string(), id.to_string()));
    }

    fn seed_intent(&self, key: &str) {
        self.intents.lock().unwrap().insert(
            key.to_string(),
            RdUncertainIntent {
                kind: RdWriteKind::Enqueue,
                created_at_ms: 1,
            },
        );
    }

    fn has(&self, key: &str) -> bool {
        self.intents.lock().unwrap().contains_key(key)
    }
}

impl RdUncertainStore for FakeStore {
    fn has_intent(&self, key: &str) -> Result<bool, String> {
        if *self.fail_read.lock().unwrap() {
            return Err("fake read failed".into());
        }
        Ok(self.has(key))
    }

    fn put_intent_if_absent(&self, key: &str, intent: &RdUncertainIntent) -> Result<bool, String> {
        if *self.fail_write.lock().unwrap() {
            return Err("fake write failed".into());
        }
        if *self.reject_put.lock().unwrap() {
            return Ok(false);
        }
        let mut intents = self.intents.lock().unwrap();
        if intents.contains_key(key) {
            return Ok(false);
        }
        intents.insert(key.to_string(), intent.clone());
        Ok(true)
    }

    fn clear_intent(&self, key: &str) -> Result<(), String> {
        if *self.fail_clear.lock().unwrap() {
            return Err("fake clear failed".into());
        }
        self.intents.lock().unwrap().remove(key);
        Ok(())
    }

    fn owns_transfer(&self, account: &str, hash: &str, id: &str) -> Result<bool, String> {
        if *self.fail_read.lock().unwrap() {
            return Err("fake read failed".into());
        }
        Ok(self.owned.lock().unwrap().contains(&(
            account.to_string(),
            hash.to_string(),
            id.to_string(),
        )))
    }
}

#[derive(Default)]
struct MockState {
    requests: Mutex<Vec<(String, String, String)>>,
    add_status: Mutex<Option<StatusCode>>,
    delay_add: Mutex<bool>,
    delete_status: Mutex<Option<StatusCode>>,
    info_count: Mutex<usize>,
}

async fn service(state: Arc<MockState>) -> (Arc<RealDebrid>, tokio::task::JoinHandle<()>) {
    let app = Router::new().fallback(any(handle)).with_state(state);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let _lock = crate::test_env::lock();
    let previous = std::env::var("REALDEBRID_API_BASE").ok();
    unsafe { std::env::set_var("REALDEBRID_API_BASE", format!("http://{addr}")) };
    let rd = Arc::new(RealDebrid::new(HttpClient::new().unwrap()));
    unsafe {
        match previous {
            Some(value) => std::env::set_var("REALDEBRID_API_BASE", value),
            None => std::env::remove_var("REALDEBRID_API_BASE"),
        }
    }
    drop(_lock);
    (rd, server)
}

async fn handle(State(state): State<Arc<MockState>>, req: Request<Body>) -> Response {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let body = req.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&body).into_owned();
    state
        .requests
        .lock()
        .unwrap()
        .push((method.clone(), path.clone(), body));

    match (method.as_str(), path.as_str()) {
        ("POST", "/torrents/addMagnet") => {
            let delay = *state.delay_add.lock().unwrap();
            if delay {
                tokio::time::sleep(std::time::Duration::from_secs(7)).await;
            }
            if let Some(status) = *state.add_status.lock().unwrap() {
                (status, "server response").into_response()
            } else {
                Json(json!({ "id": 42 })).into_response()
            }
        }
        ("GET", "/torrents/info/42") => {
            let mut count = state.info_count.lock().unwrap();
            *count += 1;
            if *count == 1 {
                Json(json!({
                    "status": "waiting_files_selection",
                    "files": [{"id": 7, "path": "Movie.2024.mkv", "bytes": 1000}]
                }))
                .into_response()
            } else {
                Json(json!({
                    "status": "downloaded",
                    "files": [{"id": 7, "path": "Movie.2024.mkv", "bytes": 1000, "selected": 1}]
                }))
                .into_response()
            }
        }
        ("POST", "/torrents/selectFiles/42") => StatusCode::NO_CONTENT.into_response(),
        ("DELETE", "/torrents/delete/42") => match *state.delete_status.lock().unwrap() {
            Some(status) => (status, "delete response").into_response(),
            None => StatusCode::NO_CONTENT.into_response(),
        },
        _ => (StatusCode::NOT_FOUND, "unexpected request").into_response(),
    }
}

fn gate() -> RdGateExecutor {
    RdGateExecutor::new(RdSchedulerConfig {
        min_gap_ms: 0.0,
        max_gap_ms: 0.0,
        cooldown_ms: 100.0,
        play_max_wait_ms: 0.0,
        success_threshold: 2,
        enabled: true,
    })
}

fn make_manager(store: &Arc<FakeStore>) -> RealDebridAutofetch {
    RealDebridAutofetch::new(gate(), store.clone())
}

fn key() -> String {
    uncertain_key(&super::transport::validate(KEY, HASH).unwrap().0, HASH)
}

#[tokio::test]
async fn enqueue_grava_intent_antes_da_rede_seleciona_arquivo_e_aguarda_marker() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;

    let id = manager
        .enqueue(
            rd,
            KEY,
            HASH,
            None,
            &PlayHint::default(),
            std::time::Duration::ZERO,
        )
        .await
        .unwrap();
    assert_eq!(id.as_deref(), Some("42"));
    assert!(store.has(&key()));
    let requests = state.requests.lock().unwrap().clone();
    assert_eq!(requests[0].0, "POST");
    assert_eq!(requests[0].1, "/torrents/addMagnet");
    assert!(requests[0].2.contains(HASH));
    assert_eq!(requests[1].1, "/torrents/info/42");
    assert_eq!(requests[2].1, "/torrents/selectFiles/42");
    assert!(requests[2].2.contains("files=7"));
    assert_eq!(requests[3].1, "/torrents/info/42");

    let account = super::transport::validate(KEY, HASH).unwrap().0;
    store.seed_owned(&account, HASH, "42");
    assert!(manager.acknowledge_marker(KEY, HASH, "42").unwrap());
    assert!(!store.has(&key()));
    server.abort();
}

#[tokio::test]
async fn falha_ao_gravar_intent_fecha_com_store_unavailable_sem_rede() {
    let store = Arc::new(FakeStore::default());
    *store.fail_write.lock().unwrap() = true;
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;
    assert_eq!(
        manager
            .enqueue(
                rd,
                KEY,
                HASH,
                None,
                &PlayHint::default(),
                std::time::Duration::ZERO
            )
            .await
            .unwrap_err(),
        RdAutofetchError::StoreUnavailable
    );
    assert!(state.requests.lock().unwrap().is_empty());
    server.abort();
}

#[tokio::test]
async fn http_429_recusa_add_e_libera_intent_enquanto_500_quarentena() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    *state.add_status.lock().unwrap() = Some(StatusCode::TOO_MANY_REQUESTS);
    let (rd, server) = service(state.clone()).await;
    assert!(manager
        .enqueue(
            rd,
            KEY,
            HASH,
            None,
            &PlayHint::default(),
            std::time::Duration::ZERO
        )
        .await
        .is_err());
    assert!(!store.has(&key()));
    server.abort();

    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    *state.add_status.lock().unwrap() = Some(StatusCode::INTERNAL_SERVER_ERROR);
    let (rd, server) = service(state.clone()).await;
    assert!(manager
        .enqueue(
            rd.clone(),
            KEY,
            HASH,
            None,
            &PlayHint::default(),
            std::time::Duration::ZERO
        )
        .await
        .is_err());
    assert!(store.has(&key()));
    assert!(matches!(
        manager
            .enqueue(
                rd,
                KEY,
                HASH,
                None,
                &PlayHint::default(),
                std::time::Duration::ZERO
            )
            .await,
        Err(RdAutofetchError::Quarantined)
    ));
    assert_eq!(state.requests.lock().unwrap().len(), 1);
    server.abort();
}

#[tokio::test]
async fn timeout_de_add_preserva_intent_e_recusa_novo_post() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    *state.delay_add.lock().unwrap() = true;
    let (rd, server) = service(state.clone()).await;

    assert!(manager
        .enqueue(
            rd.clone(),
            KEY,
            HASH,
            None,
            &PlayHint::default(),
            std::time::Duration::ZERO,
        )
        .await
        .is_err());
    assert!(store.has(&key()));
    assert!(matches!(
        manager
            .enqueue(
                rd,
                KEY,
                HASH,
                None,
                &PlayHint::default(),
                std::time::Duration::ZERO
            )
            .await,
        Err(RdAutofetchError::Quarantined)
    ));
    assert_eq!(state.requests.lock().unwrap().len(), 1);
    server.abort();
}

#[tokio::test]
async fn remove_exige_marker_pregrava_intent_e_404_confirma_remocao() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;
    assert!(!manager.remove(rd.clone(), KEY, HASH, "42").await.unwrap());
    assert!(state.requests.lock().unwrap().is_empty());

    let account = super::transport::validate(KEY, HASH).unwrap().0;
    store.seed_owned(&account, HASH, "42");
    *state.delete_status.lock().unwrap() = Some(StatusCode::NOT_FOUND);
    assert!(manager.remove(rd, KEY, HASH, "42").await.unwrap());
    assert!(!store.has(&key()));
    let requests = state.requests.lock().unwrap();
    assert_eq!(requests[0].0, "DELETE");
    assert_eq!(requests[0].1, "/torrents/delete/42");
    server.abort();
}

#[path = "realdebrid_autofetch_tests_part2.rs"]
mod part2;
