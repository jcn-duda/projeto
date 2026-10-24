//! API ADMINISTRATIVA do store nativo de `streams:v21` (loopback + token).
//!
//! O SWR do corte mora em `data/streams.db` (processo do gateway). Quem precisa
//! MEXER nele é o Node: `/resolve` invalida a lista de uma obra quando o play
//! prova `NoVideoError`/`DubLieError`/`EpisodePickError`/451, o painel limpa o
//! cache no `clear-cache`, e o `/stream-trace.json` lê o ledger. Sem esta
//! superfície essas três coisas ficavam inertes no corte (dívida F4.4a).
//!
//! Ela NÃO é pública: escuta só em loopback (`STREAM_STORE_ADMIN_LISTEN`,
//! default `127.0.0.1:8711`), exige `X-Indexer-Test-Token` e nunca é montada no
//! roteador da 7000 (o gateway recusa `/internal/*` antes do proxy). Sem token
//! configurado responde 503 — mesmo contrato da API interna de debrid.
//!
//! Rotas:
//!
//! | rota | efeito |
//! |---|---|
//! | `POST /streams/invalidate` `{"imdbId":"tt…"}` | apaga as chaves da obra (`invalidateStreamsForObra`) |
//! | `POST /streams/invalidate` `{"hash":"<40hex>"}` | apaga as entradas que mencionam o hash |
//! | `POST /streams/clear` `{}` | limpa o namespace todo (`clear-cache` global) |
//! | `POST /streams/clear` `{"suffix":":…"}` | limpa só um escopo (instalação) |
//! | `GET /streams/trace?type=&id=[&key=]` | ledger da obra (o `/stream-trace.json`) |
//! | `GET /streams/stats` | ocupação/cota (diagnóstico e teste) |
//! | `GET /harvest` + `POST /harvest/{enqueue,pause,drain,clear}` | painel e controle do colhedor (`crate::harvest`) |
//!
//! O colhedor nativo monta as rotas `/harvest*` neste MESMO roteador —
//! loopback e token são os mesmos, sem segundo servidor. Sem colhedor
//! (`harvest: None`) o contrato continua valendo com `enabled:false`.
//!
//! A superfície sobe SEMPRE que o corte nativo está de pé: não há rollback por
//! env. Desligá-la exigiria o Node voltar a ser o dono único de invalidação e o
//! gateway a não injetar `bad`/`lie` — o que é imagem/commit anterior, não flag.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use adom_store::StreamsStore;

use crate::harvest::HarvestHandle;

/// Env do endpoint interno. O Node lê a MESMA env (`src/config/stream-store.ts`).
pub const LISTEN_ENV: &str = "STREAM_STORE_ADMIN_LISTEN";
/// Token próprio; cai para `DEBRID_INTERNAL_TOKEN` e `JACKETT_TEST_TOKEN`.
pub const TOKEN_ENV: &str = "STREAM_STORE_ADMIN_TOKEN";

pub const DEFAULT_LISTEN: &str = "127.0.0.1:8711";

/// Config da API administrativa.
#[derive(Clone, Debug)]
pub struct AdminConfig {
    pub listen: SocketAddr,
    pub token: String,
}

/// Endereço + token. A superfície sobe sempre; só `Err` (endereço inválido ou
/// fora de loopback) impede o bind.
pub fn config_from_env() -> Result<AdminConfig, String> {
    let listen = std::env::var(LISTEN_ENV)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| DEFAULT_LISTEN.to_string());
    let addr: SocketAddr = listen
        .parse()
        .map_err(|_| format!("{LISTEN_ENV} invalido: {listen}"))?;
    if !addr.ip().is_loopback() {
        return Err(format!("API do streams.db só escuta em loopback: {listen}"));
    }
    let token = token_from_env();
    Ok(AdminConfig {
        listen: addr,
        token,
    })
}

/// `STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`.
/// A ordem é a mesma que o Node usa para achar o token do outro lado.
pub fn token_from_env() -> String {
    for key in [TOKEN_ENV, "DEBRID_INTERNAL_TOKEN", "JACKETT_TEST_TOKEN"] {
        let Ok(value) = std::env::var(key) else {
            continue;
        };
        let value = value.trim().to_string();
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

pub(crate) struct AdminState {
    token: String,
    store: Arc<StreamsStore>,
    /// Graça do SWR — o mesmo `STREAM_STALE_GRACE_SECONDS` da busca: o trace
    /// enxerga exatamente o que a busca enxergaria (inclusive stale).
    grace_seconds: u64,
    /// Colhedor nativo; `None` = desligado (`HARVEST_ENABLED=false`), store
    /// indisponível ou corte nativo desligado. As rotas `/harvest*` respondem
    /// o contrato com `enabled:false`.
    pub(crate) harvest: Option<HarvestHandle>,
}

pub fn router(
    cfg: &AdminConfig,
    store: Arc<StreamsStore>,
    grace_seconds: u64,
    harvest: Option<HarvestHandle>,
) -> Router {
    if cfg.token.is_empty() {
        eprintln!("[gateway] streams admin sem token; responde 503");
    }
    let state = Arc::new(AdminState {
        token: cfg.token.clone(),
        store,
        grace_seconds,
        harvest,
    });
    Router::new()
        .route("/streams/invalidate", post(invalidate))
        .route("/streams/clear", post(clear))
        .route("/streams/trace", get(trace))
        .route("/streams/stats", get(stats))
        .route("/indexers/status", get(indexer_status))
        .merge(crate::harvest::admin_router())
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state)
}

/// Sobe a API e devolve SÓ quando o socket fecha (erro) — o chamador faz
/// `tokio::spawn`. Falha de bind é logada e não derruba o gateway.
pub async fn serve(
    cfg: AdminConfig,
    store: Arc<StreamsStore>,
    grace_seconds: u64,
    harvest: Option<HarvestHandle>,
) -> Result<(), String> {
    let listen = cfg.listen;
    let app = router(&cfg, store, grace_seconds, harvest);
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|err| format!("nao escutei {listen}: {err}"))?;
    let bound = listener
        .local_addr()
        .map_err(|err| format!("endereco local: {err}"))?;
    eprintln!("[gateway] streams admin (streams.db) em {bound}");
    axum::serve(listener, app)
        .await
        .map_err(|err| format!("API do streams.db encerrou: {err}"))
}

async fn auth(
    State(state): State<Arc<AdminState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if state.token.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "streams_admin_disabled" })),
        )
            .into_response();
    }
    let got = req
        .headers()
        .get("x-indexer-test-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !tokens_match(&state.token, got) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "unauthorized" })),
        )
            .into_response();
    }
    next.run(req).await
}

/// Comparação em tempo constante (sem dependência nova): só o TAMANHO vaza, e
/// o tamanho de um token não é segredo.
fn tokens_match(expected: &str, got: &str) -> bool {
    let (expected, got) = (expected.as_bytes(), got.as_bytes());
    if expected.len() != got.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(got) {
        diff |= a ^ b;
    }
    diff == 0
}

async fn invalidate(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    let imdb = body.get("imdbId").and_then(Value::as_str).unwrap_or("");
    let hash = body.get("hash").and_then(Value::as_str).unwrap_or("");
    if imdb.is_empty() == hash.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "envie imdbId OU hash" })),
        )
            .into_response();
    }
    let (scope, result) = if !imdb.is_empty() {
        ("obra", state.store.invalidate_for_obra(imdb))
    } else {
        ("hash", state.store.invalidate_for_hash(hash))
    };
    match result {
        Ok(removed) => {
            Json(json!({ "ok": true, "scope": scope, "removed": removed })).into_response()
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}

async fn clear(State(state): State<Arc<AdminState>>, body: Option<Json<Value>>) -> Response {
    let suffix = body
        .as_ref()
        .and_then(|Json(value)| value.get("suffix"))
        .and_then(Value::as_str)
        .unwrap_or("");
    match state.store.clear_by_suffix(suffix) {
        Ok(removed) => Json(json!({
            "ok": true,
            "removed": removed,
            "entries": state.store.len().unwrap_or(0),
            "scope": if suffix.is_empty() { "all" } else { "suffix" },
        }))
        .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}

async fn trace(
    State(state): State<Arc<AdminState>>,
    Query(params): Query<std::collections::BTreeMap<String, String>>,
) -> Response {
    let kind = params.get("type").map(String::as_str).unwrap_or("");
    let id = params.get("id").map(String::as_str).unwrap_or("");
    if kind != "movie" && kind != "series" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "type deve ser movie ou series" })),
        )
            .into_response();
    }
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "id obrigatório" })),
        )
            .into_response();
    }
    let now = now_ms();
    let grace = state.grace_seconds;
    // Chave exata quando o Node manda a dele (mesma `streamsCacheKey`); senão a
    // leitura do operador, que escolhe a build mais recente da obra.
    let exact = params.get("key").map(String::as_str).unwrap_or("");
    let mut hit = None;
    if !exact.is_empty() {
        match state.store.trace_entry(exact, grace, now) {
            Ok(found) => hit = found,
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "error": err })),
                )
                    .into_response()
            }
        }
    }
    if hit.is_none() {
        match state.store.latest_trace(kind, id, grace, now) {
            Ok(found) => hit = found,
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "error": err })),
                )
                    .into_response()
            }
        }
    }
    let Some(hit) = hit else {
        return Json(json!({ "ok": true, "found": false, "source": "rust" })).into_response();
    };
    let entry = &hit.value;
    Json(json!({
        "ok": true,
        "found": true,
        "source": "rust",
        "cache": {
            "remainingS": hit.remaining_s,
            "partial": entry.partial,
            "debridKnown": entry.debrid_known == Some(true),
            "stale": hit.stale,
        },
        // O ledger vai CRU (é o mesmo JSON que o Node serializa) e os itens só
        // com `name`/`infoHash` — a sonda `mode=live` do painel precisa dos
        // hashes, e nada de URL/magnet/apiKey sai daqui.
        "trace": entry.trace,
        "searchMeta": entry.search_meta,
        "streams": entry
            .streams
            .iter()
            .map(|item| json!({
                "name": item.name,
                "infoHash": stream_hash(item.info_hash.as_deref(), item.url.as_deref()),
            }))
            .filter(|item| item["infoHash"].as_str().is_some_and(|h| !h.is_empty()))
            .collect::<Vec<_>>(),
    }))
    .into_response()
}

async fn stats(State(state): State<Arc<AdminState>>) -> Response {
    Json(json!({
        "ok": true,
        "entries": state.store.len().unwrap_or(0),
        "quota": state.store.quota(),
    }))
    .into_response()
}

/// `GET /indexers/status` — última consulta medida de cada indexer nas buscas
/// vivas + a foto do circuito (`adom_sources::jackett::status_board`). O Node
/// traduz para o `indexer-status.ts`; sem isto o painel ficava "desconhecido".
async fn indexer_status() -> Response {
    let now = adom_sources::now_ms();
    Json(json!({
        "ok": true,
        "now": now,
        "indexers": adom_sources::jackett::status_board::snapshot(now),
    }))
    .into_response()
}

/// Hash do item para a sonda live: o campo quando existe (item P2P); senão o
/// segmento de 40 hex da URL relativa de `/resolve`.
fn stream_hash(info_hash: Option<&str>, url: Option<&str>) -> String {
    if let Some(hash) = info_hash.filter(|h| !h.is_empty()) {
        return hash.to_ascii_lowercase();
    }
    let Some(url) = url else {
        return String::new();
    };
    url.split(|c: char| !c.is_ascii_hexdigit())
        .find(|part| part.len() == 40 && part.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "store_admin_tests.rs"]
mod store_admin_tests;
