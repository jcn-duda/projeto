//! Servidor HTTP de teste (axum) + store de gravação.
//!
//! Cada cenário é escolhido pelo IMDb id: os clientes são caixas-pretas e o
//! servidor falso responde Cinemeta e TMDB na MESMA base. Assim o teste mede o
//! contrato público (find duplo, aliases, cache, prazo) sem tocar na rede real.

// Cada arquivo de teste compila este módulo e usa um subconjunto dos cenários.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_sources::{CacheValue, CinemetaConfig, MetaStore, SourcesConfig, TmdbConfig};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};

pub const MOVIE_OK: &str = "tt1000001";
pub const EN_FAILS: &str = "tt1000002";
pub const PT_FAILS: &str = "tt1000003";
pub const ORIGINAL_IGNORED: &str = "tt1000004";
pub const ALIASES: &str = "tt1000005";
pub const MULTIWORK: &str = "tt1000006";
pub const ONE_PART: &str = "tt1000007";
pub const HOME_RELEASE: &str = "tt1000008";
pub const CINEMETA_FAILS: &str = "tt1000009";
pub const SLOW: &str = "tt1000010";
pub const SERIES: &str = "tt1000011";
pub const ALIASES_FAIL: &str = "tt1000012";
pub const YEAR_DIVERGE: &str = "tt1000013";
pub const PT_EMPTY: &str = "tt1000014";
pub const CINEMETA_404: &str = "tt1000015";
pub const EN_SLOW: &str = "tt1000016";

/// Epoch ms de "2026-11-15" (data doméstica do The Odyssey no cenário).
pub const HOME_RELEASE_AT: i64 = 1_794_700_800_000;
/// Epoch ms de "2026-10-05" (Antes da data doméstica).
pub const BEFORE_HOME_RELEASE: i64 = 1_791_158_400_000;

#[derive(Clone, Default)]
pub struct FakeApi {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    calls: Mutex<Vec<Call>>,
}

/// Uma requisição observada: caminho, `language` da query e `User-Agent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub path: String,
    pub language: Option<String>,
    pub user_agent: Option<String>,
}

impl FakeApi {
    pub async fn start() -> (Self, String) {
        let api = Self::default();
        let app = Router::new().fallback(any(serve)).with_state(api.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind do servidor de teste");
        let addr = listener.local_addr().expect("endereço do servidor");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (api, format!("http://{addr}"))
    }

    pub fn calls(&self) -> Vec<Call> {
        self.inner.calls.lock().expect("calls envenenado").clone()
    }

    pub fn count(&self, fragment: &str) -> usize {
        self.calls()
            .iter()
            .filter(|call| call.path.contains(fragment))
            .count()
    }

    /// Quantos `/find` foram feitos naquele idioma.
    pub fn find_calls(&self, language: &str) -> usize {
        self.calls()
            .iter()
            .filter(|call| {
                call.path.starts_with("/find/") && call.language.as_deref() == Some(language)
            })
            .count()
    }
}

async fn serve(
    State(api): State<FakeApi>,
    uri: Uri,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let path = uri.path().to_string();
    let language = query.get("language").cloned();
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    api.inner
        .calls
        .lock()
        .expect("calls envenenado")
        .push(Call {
            path: path.clone(),
            language: language.clone(),
            user_agent,
        });
    if path.contains(SLOW) || (path.contains(EN_SLOW) && language.as_deref() == Some("en-US")) {
        tokio::time::sleep(Duration::from_millis(700)).await;
    }
    match route(&path, language.as_deref()) {
        Some((status, body)) => (status, axum::Json(body)).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn route(path: &str, language: Option<&str>) -> Option<(StatusCode, Value)> {
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match segments.as_slice() {
        ["meta", _kind, file] => {
            let imdb = file.strip_suffix(".json")?;
            match imdb {
                CINEMETA_FAILS => Some((StatusCode::INTERNAL_SERVER_ERROR, json!({}))),
                CINEMETA_404 => Some((StatusCode::NOT_FOUND, json!({}))),
                _ => Some((StatusCode::OK, json!({ "meta": cinemeta_meta(imdb) }))),
            }
        }
        ["find", imdb] => find_response(imdb, language),
        ["movie", id, "alternative_titles"] => {
            if *id == "112" {
                return Some((StatusCode::INTERNAL_SERVER_ERROR, json!({})));
            }
            Some((StatusCode::OK, json!({ "titles": br_aliases(id) })))
        }
        ["tv", _id, "alternative_titles"] => Some((StatusCode::OK, json!({ "results": [] }))),
        ["movie", "105", "release_dates"] => Some((StatusCode::OK, release_dates())),
        ["movie", _id, "release_dates"] => Some((StatusCode::OK, json!({ "results": [] }))),
        ["movie", id] => Some((StatusCode::OK, detail(id))),
        ["collection", id] => Some((StatusCode::OK, collection(id))),
        _ => None,
    }
}

fn find_response(imdb: &str, language: Option<&str>) -> Option<(StatusCode, Value)> {
    let en = language == Some("en-US");
    match (imdb, en) {
        (PT_FAILS, false) => return Some((StatusCode::INTERNAL_SERVER_ERROR, json!({}))),
        (EN_FAILS, true) => return Some((StatusCode::INTERNAL_SERVER_ERROR, json!({}))),
        (PT_EMPTY, false) => {
            return Some((
                StatusCode::OK,
                json!({ "movie_results": [], "tv_results": [] }),
            ));
        }
        (ORIGINAL_IGNORED, true) => {
            // A consulta en-US responde SEM `title`/`name`, só com o original
            // italiano. Quem promover `original_*` falha aqui.
            return Some((
                StatusCode::OK,
                json!({
                    "movie_results": [{
                        "id": 103,
                        "original_title": "Se sei vivo spara",
                        "original_language": "it"
                    }],
                    "tv_results": []
                }),
            ));
        }
        _ => {}
    }
    if imdb == SERIES {
        return Some((
            StatusCode::OK,
            json!({ "movie_results": [], "tv_results": [tv_item(en)] }),
        ));
    }
    Some((
        StatusCode::OK,
        json!({ "movie_results": [movie_item(imdb, en)], "tv_results": [] }),
    ))
}

fn movie_item(imdb: &str, en: bool) -> Value {
    let (id, pt_title, en_title, original, lang, date) = match imdb {
        MOVIE_OK => (101, "Coringa", "Joker", "Joker", "en", "2019-10-02"),
        ALIASES => (102, "Lioness", "Lioness", "Lioness", "en", "2018-07-22"),
        ORIGINAL_IGNORED => (
            103,
            "Django Kill",
            "Django Kill",
            "Se sei vivo spara",
            "it",
            "1967-01-27",
        ),
        MULTIWORK => (
            104,
            "The Hunger Games",
            "The Hunger Games",
            "The Hunger Games",
            "en",
            "2012-03-23",
        ),
        ONE_PART => (
            107,
            "Solo Adventures",
            "Solo Adventures",
            "Solo Adventures",
            "en",
            "2018-05-25",
        ),
        HOME_RELEASE => (
            105,
            "The Odyssey",
            "The Odyssey",
            "The Odyssey",
            "en",
            "2026-07-15",
        ),
        YEAR_DIVERGE => (113, "Monster", "Monster", "Monster", "en", "2021-09-17"),
        ALIASES_FAIL => (
            112,
            "Filme Teste",
            "Test Movie",
            "Test Movie",
            "en",
            "2020-01-01",
        ),
        _ => (
            120,
            "Filme Teste",
            "Test Movie",
            "Test Movie",
            "en",
            "2020-01-01",
        ),
    };
    let mut item = json!({
        "id": id,
        "title": if en { en_title } else { pt_title },
        "original_title": original,
        "original_language": lang,
        "release_date": date
    });
    if imdb == MULTIWORK {
        item["belongs_to_collection"] = json!({ "id": 7, "name": "The Hunger Games Collection" });
    }
    if imdb == ONE_PART {
        item["belongs_to_collection"] = json!({ "id": 8, "name": "Solo Adventures Collection" });
    }
    item
}

fn tv_item(en: bool) -> Value {
    let _ = en; // título igual nos dois idiomas neste cenário
    json!({
        "id": 106,
        "name": "Lioness",
        "original_name": "Lioness",
        "original_language": "en",
        "first_air_date": "2018-07-22"
    })
}

fn cinemeta_meta(imdb: &str) -> Value {
    match imdb {
        SERIES => json!({
            "name": "Lioness",
            "year": "2018–",
            "type": "series",
            "firstAired": "2018-07-22",
            "videos": [
                { "season": 0, "episode": 1, "released": "2019-12-01" },
                { "season": 1, "episode": 1, "released": "2020-01-01" },
                { "season": 1, "episode": 2, "firstAired": "2020-01-08" },
                { "season": 2, "episode": 1 }
            ]
        }),
        YEAR_DIVERGE => json!({ "name": "Monster", "year": "2018", "type": "movie" }),
        ORIGINAL_IGNORED => {
            json!({ "name": "Django Kill", "year": "1967", "type": "movie" })
        }
        HOME_RELEASE => json!({
            "name": "The Odyssey",
            "year": "2026",
            "type": "movie",
            "released": "2026-07-15T00:00:00.000Z"
        }),
        MULTIWORK => json!({ "name": "Jogos Vorazes", "year": "2012", "type": "movie" }),
        ONE_PART => json!({ "name": "Solo Adventures", "year": "2018", "type": "movie" }),
        MOVIE_OK => json!({
            "name": "Coringa",
            "year": "2019",
            "type": "movie",
            "released": "2019-10-02T00:00:00.000Z"
        }),
        _ => json!({ "name": "Filme Teste", "year": "2020", "type": "movie" }),
    }
}

fn br_aliases(id: &str) -> Value {
    if id != "102" {
        return json!([]);
    }
    json!([
        { "iso_3166_1": "BR", "title": "Operação: Lioness" },
        { "iso_3166_1": "BR", "title": "Kill" },
        { "iso_3166_1": "US", "title": "US Alias" },
        { "iso_3166_1": "BR", "title": "Agente Lioness" },
        { "iso_3166_1": "BR", "title": "Lioness" }
    ])
}

fn detail(id: &str) -> Value {
    if id == "104" {
        json!({
            "id": 104,
            "belongs_to_collection": { "id": 7, "name": "The Hunger Games Collection" }
        })
    } else {
        json!({ "id": id.parse::<u64>().unwrap_or(0) })
    }
}

fn collection(id: &str) -> Value {
    match id {
        "7" => json!({
            "name": "The Hunger Games Collection",
            "parts": [
                { "release_date": "2012-03-23" },
                { "release_date": "2013-11-22" },
                { "release_date": "2014-11-21" }
            ]
        }),
        "8" => json!({
            "name": "Solo Adventures Collection",
            "parts": [{ "release_date": "2018-05-25" }]
        }),
        _ => json!({ "name": "", "parts": [] }),
    }
}

fn release_dates() -> Value {
    json!({
        "results": [
            {
                "iso_3166_1": "US",
                "release_dates": [
                    { "type": 3, "release_date": "2026-07-15" },
                    { "type": 4, "release_date": "2026-11-15" },
                    { "type": 6, "release_date": "2026-12-01" }
                ]
            },
            {
                "iso_3166_1": "BR",
                "release_dates": [{ "type": 5, "release_date": "2026-11-20" }]
            }
        ]
    })
}

/// Config apontando para o servidor falso, com TTLs distinguíveis nos testes de
/// cache (777 longo, 111 miss autoritativo, 40 retry transitório).
pub fn config(base: &str) -> SourcesConfig {
    SourcesConfig {
        user_agent: "adom-sources-test/1.0".to_string(),
        cinemeta: CinemetaConfig {
            base_url: base.to_string(),
            request_timeout_ms: 2_000,
            cache_ttl_secs: 86_400,
            miss_ttl_secs: 300,
            transient_miss_ttl_secs: 30,
        },
        tmdb: TmdbConfig {
            base_url: base.to_string(),
            api_key: "chave-teste".to_string(),
            request_timeout_ms: 2_000,
            cache_ttl_secs: 777,
            miss_ttl_secs: 111,
            transient_miss_ttl_secs: 40,
            collection_timeout_ms: 1_500,
            home_release_ttl_secs: 999,
            pre_home_release_cut: true,
        },
    }
}

/// Store em memória que também grava cada `set` (chave + TTL) para o teste
/// conferir a política "TTL longo só com ok:true".
#[derive(Default)]
pub struct RecordingStore {
    entries: Mutex<HashMap<String, CacheValue>>,
    sets: Mutex<Vec<SetCall>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetCall {
    pub key: String,
    pub ttl_seconds: u64,
}

impl RecordingStore {
    pub fn sets(&self) -> Vec<SetCall> {
        self.sets.lock().expect("sets envenenado").clone()
    }

    pub fn set_for(&self, key: &str) -> Option<SetCall> {
        self.sets().into_iter().rev().find(|call| call.key == key)
    }
}

impl MetaStore for RecordingStore {
    fn get(&self, key: &str, _now_ms: i64) -> Option<CacheValue> {
        self.entries
            .lock()
            .expect("entries envenenado")
            .get(key)
            .cloned()
    }

    fn set(&self, key: &str, value: CacheValue, ttl_seconds: u64, _now_ms: i64) {
        self.sets.lock().expect("sets envenenado").push(SetCall {
            key: key.to_string(),
            ttl_seconds,
        });
        self.entries
            .lock()
            .expect("entries envenenado")
            .insert(key.to_string(), value);
    }
}
