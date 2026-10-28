use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::super::AllDebrid;
use crate::http::HttpClient;

const KEY: &str = "sweep-test-key";

#[derive(Clone)]
struct Scene {
    hits: Arc<Mutex<Vec<(String, String, bool)>>>,
    rows: Value,
    detail: Value,
}

async fn respond(State(scene): State<Scene>, request: Request<Body>) -> Response {
    let query = request.uri().query().unwrap_or("").to_string();
    let path = request.uri().path().to_string();
    let auth = request
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        == Some("Bearer sweep-test-key");
    scene
        .hits
        .lock()
        .unwrap()
        .push((path.clone(), query.clone(), auth));
    let data = if query.contains("id=") {
        scene.detail.clone()
    } else {
        scene.rows.clone()
    };
    let _ = request.into_body();
    (
        StatusCode::OK,
        json!({"status":"success","data":data}).to_string(),
    )
        .into_response()
}

async fn adapter(scene: Scene) -> AllDebrid {
    let app = Router::new().fallback(any(respond)).with_state(scene);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let lock = crate::test_env::lock();
    let previous = std::env::var("ALLDEBRID_API_BASE").ok();
    unsafe {
        std::env::set_var("ALLDEBRID_API_BASE", format!("http://{address}"));
    }
    let api = AllDebrid::new(HttpClient::new().unwrap());
    unsafe {
        match previous {
            Some(value) => std::env::set_var("ALLDEBRID_API_BASE", value),
            None => std::env::remove_var("ALLDEBRID_API_BASE"),
        }
    }
    drop(lock);
    api
}

#[tokio::test]
async fn lista_normaliza_campos_data_auth_e_ignora_linhas_invalidas() {
    let scene = Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[
            {"id":12,"hash":"ABCDEF","status":"Ready","ready":false,"filename":"filme.mkv","size":42,"uploadDate":1700000000},
            {"id":"13","hash":"fedcba","status":"Downloading","uploadDate":"12"},
            {"id":14,"hash":""},{"hash":"sem-id"}
        ]}),
        detail: json!({}),
    };
    let hits = scene.hits.clone();
    let api = adapter(scene).await;
    let rows = api.sweep_magnet_list(KEY).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, "12");
    assert_eq!(rows[0].hash, "abcdef");
    assert!(rows[0].ready);
    assert_eq!(rows[0].filename, "filme.mkv");
    assert_eq!(rows[0].upload_date_ms, 1_700_000_000_000.0);
    assert!(!rows[1].ready);
    assert_eq!(rows[1].upload_date_ms, 12_000.0);
    let hits = hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, "/magnet/status");
    assert!(hits[0].1.contains("agent=stremio-adom"));
    assert!(hits[0].2);
}

#[tokio::test]
async fn arquivos_sao_por_id_so_se_ready_e_achata_arvore_sem_link() {
    let scene = Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({"magnets":[]}),
        detail: json!({"magnets":[{"status":"rEaDy","files":[
            {"n":"Pasta","e":[{"n":"filme.mkv","s":123,"l":"https://segredo.invalid"}]},
            {"n":"leia-me.txt","s":4}
        ]}]}),
    };
    let hits = scene.hits.clone();
    let api = adapter(scene).await;
    let files = api.sweep_magnet_files(KEY, "42 &x").await.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "Pasta/filme.mkv");
    assert_eq!(files[0].size, 123.0);
    let hits = hits.lock().unwrap();
    assert_eq!(hits.len(), 1);
    assert!(hits[0].1.contains("id=42+%26x") || hits[0].1.contains("id=42%20%26x"));
    assert!(hits[0].2);
}

#[tokio::test]
async fn magnet_nao_pronto_nao_expoe_arquivos() {
    let api = adapter(Scene {
        hits: Arc::new(Mutex::new(Vec::new())),
        rows: json!({}),
        detail: json!({"magnets":{"status":"Downloading","files":[{"n":"x.mkv","s":9,"l":"x"}]}}),
    })
    .await;
    assert!(api.sweep_magnet_files(KEY, "7").await.unwrap().is_empty());
}
