//! Servidor falso (axum) — prova token no header, `encoded` no body, parse
//! do shape real e HTTP erro ≠ sucesso. Nunca panic no cliente.
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::Json;
use axum::Router;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use super::InternalSearchClient;
use crate::internal_types::MetaRequest;

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
