//! Infra compartilhada dos testes do TMDB: servidor HTTP falso no loopback e o
//! cliente REAL apontando para ele. Vive num módulo só de `cfg(test)` para não
//! duplicar o mesmo servidor em `search_tests` e `identify_http_tests`.
//!
//! O filtro de ano ±1 mora em [`super::search::search_by_title`], não na API:
//! só o cliente real exercita o caminho completo. O [`super::stub::StubTmdb`]
//! cobre os vereditos que não dependem de ano (casamento, ambíguo, falha).

use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};

use super::identify::IdentifyInput;
use super::search::{SearchWorkType, TmdbSearchResult};
use super::TmdbClient;
use crate::cache::MemoryMetaStore;
use crate::config::TmdbConfig;

type Responder = dyn Fn(&str) -> (u16, Value) + Send + Sync;

/// TMDB de mentira em HTTP: `responder` recebe path+query e devolve status/corpo.
#[derive(Clone)]
pub(crate) struct FakeTmdb {
    calls: Arc<Mutex<Vec<String>>>,
    responder: Arc<Responder>,
}

impl FakeTmdb {
    /// Sobe o servidor em porta efêmera e devolve (`self`, base URL).
    pub(crate) async fn start(
        responder: impl Fn(&str) -> (u16, Value) + Send + Sync + 'static,
    ) -> (Self, String) {
        let fake = Self {
            calls: Arc::new(Mutex::new(Vec::new())),
            responder: Arc::new(responder),
        };
        let app = Router::new().fallback(any(serve)).with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind do servidor de teste");
        let addr = listener.local_addr().expect("endereço do servidor");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (fake, format!("http://{addr}"))
    }

    /// Alvos pedidos, com path e query (`/search/movie?api_key=…`).
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls envenenado").clone()
    }
}

async fn serve(State(fake): State<FakeTmdb>, uri: Uri) -> Response {
    let target = uri
        .path_and_query()
        .map_or_else(|| uri.path().to_string(), |pq| pq.as_str().to_string());
    fake.calls
        .lock()
        .expect("calls envenenado")
        .push(target.clone());
    let (status, body) = (fake.responder)(&target);
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, axum::Json(body)).into_response()
}

/// Cliente real apontando para o servidor falso (timeout curto).
pub(crate) fn client(base: &str, api_key: &str) -> TmdbClient {
    let config = TmdbConfig {
        base_url: base.to_string(),
        api_key: api_key.to_string(),
        request_timeout_ms: 1_000,
        ..TmdbConfig::default()
    };
    TmdbClient::new(config, "adom-test", Arc::new(MemoryMetaStore::new())).expect("cliente")
}

/// Entrada de identificação de FILME com o ano dado.
pub(crate) fn input<'a>(title: &'a str, year: Option<i64>) -> IdentifyInput<'a> {
    IdentifyInput {
        kind: SearchWorkType::Movie,
        title,
        year,
        ..IdentifyInput::default()
    }
}

/// Item de `/search/movie`.
pub(crate) fn movie(id: u64, title: &str, original: &str, date: &str) -> Value {
    json!({ "id": id, "title": title, "original_title": original, "release_date": date })
}

/// Item de `/search/tv`.
pub(crate) fn tv(id: u64, name: &str, original: &str, date: &str) -> Value {
    json!({ "id": id, "name": name, "original_name": original, "first_air_date": date })
}

/// Ids dos hits sobreviventes ao filtro.
pub(crate) fn ids(result: &TmdbSearchResult) -> Vec<u64> {
    result.hits.iter().map(|hit| hit.tmdb_id).collect()
}
