//! Corte nativo de `/stream` (`ROUTES_RUST` contém o token exato `stream`).
//!
//! Prioridade sobre `stream-shadow`: com o corte ligado o cliente NÃO passa pelo
//! Node nem pela sombra. A rede de coleta/metadados ainda mora no Node via
//! `POST /internal/search/*` (`InternalSearchClient` / `NodeRoutes`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::response::IntoResponse;
use http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE, HOST, USER_AGENT};
use http::{HeaderMap, Method, Request, Response, StatusCode};

use adom_search::orchestrator::{
    sources_rust_includes, AdapterDebridFactory, NoDebridFactory, NodeMetaSource, NodeRoutes,
    NodeTailEffects, NoopTailEffects, Orchestrator, StreamRequest,
};
use adom_search::{FallbackCheck, MemorySwrStore, NodeInternalFallback, StreamResponse, SwrStore};
use adom_store::StreamsStore;

/// Default relativo ao cwd do processo (volume `docker-data/addon` → `data/`).
const DEFAULT_STREAMS_DB: &str = "data/streams.db";

/// Path do SQLite `streams:v21`. Env `STREAMS_DB` vence; senão [`DEFAULT_STREAMS_DB`].
pub fn streams_db_path() -> PathBuf {
    streams_db_path_from(std::env::var("STREAMS_DB").ok().as_deref())
}

fn streams_db_path_from(env: Option<&str>) -> PathBuf {
    match env.map(str::trim).filter(|s| !s.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => PathBuf::from(DEFAULT_STREAMS_DB),
    }
}

/// Abre `StreamsStore` em disco; se falhar, memória (+ log) — o boot não cai.
pub fn open_swr_store() -> Arc<dyn SwrStore> {
    open_swr_store_at(&streams_db_path())
}

fn open_swr_store_at(path: &Path) -> Arc<dyn SwrStore> {
    match StreamsStore::open(path) {
        Ok(store) => {
            eprintln!("[gateway] streams store: {}", path.display());
            Arc::new(store)
        }
        Err(err) => {
            eprintln!(
                "[gateway] streams.db indisponível ({}): {err}; usando memória",
                path.display()
            );
            match StreamsStore::open_memory() {
                Ok(store) => Arc::new(store),
                Err(mem_err) => {
                    eprintln!("[gateway] streams store memória falhou: {mem_err}; MemorySwrStore");
                    Arc::new(MemorySwrStore::new())
                }
            }
        }
    }
}

/// Monta o orquestrador de produção: store SWR compartilhado, coleta via
/// rotas internas (se `JACKETT_TEST_TOKEN` existir) e debrid com reserva Node.
///
/// Opt-in `SOURCES_RUST=jackett|prowlarr|torrentio|bludv|mico` (CSV): collect
/// nativo; exclusão mútua (jackett > prowlarr > torrentio > bludv > mico).
/// Meta/tail continuam no Node quando as rotas internas existem. Default OFF
/// — corte stream segue em `POST /internal/search/collect`.
pub fn build_orchestrator() -> Orchestrator {
    let store = open_swr_store();
    let mut orch = Orchestrator::new(orchestrator_config_from_env(), store);
    let native = adom_search::orchestrator::try_sources_rust_native_from_env();
    let skip_sources: Vec<String> = native.iter().map(|(t, _)| t.to_string()).collect();
    let native_collectors: Vec<Arc<dyn adom_search::orchestrator::Collector>> =
        native.into_iter().map(|(_, c)| c).collect();
    match NodeRoutes::from_env() {
        Some(routes) => {
            let routes = Arc::new(routes);
            let node_collector = Arc::new(
                adom_search::orchestrator::NodeCollector::new(routes.clone())
                    .with_skip_sources(skip_sources.clone())
                    .with_skip_account(true),
            );
            let collector: Arc<dyn adom_search::orchestrator::Collector> =
                if native_collectors.is_empty() {
                    node_collector
                } else {
                    eprintln!(
                        "[gateway] collect composto via adom-sources ({}) + NodeCollector",
                        sources_rust_label()
                    );
                    let mut all = native_collectors;
                    all.push(node_collector);
                    Arc::new(adom_search::orchestrator::CompositeCollector::new(all))
                };
            // Sombra de fonte (SOURCES_RUST_SHADOW, default vazio): compare-only,
            // não altera o lote primário nem toca store/debrid/tail/efeitos.
            let collector = adom_search::orchestrator::wrap_collector_with_source_shadow(
                collector,
                Some(routes.clone() as Arc<dyn adom_search::orchestrator::InternalRoutes>),
            );
            orch = orch
                .with_collector(collector)
                .with_meta(Arc::new(NodeMetaSource::new(routes.clone())))
                .with_tail(Arc::new(NodeTailEffects::new(routes.clone())))
                .with_internal_routes(routes);
        }
        None => {
            if !native_collectors.is_empty() {
                eprintln!(
                    "[gateway] {} sem rotas Node — collect nativo; meta/tail indisponíveis",
                    sources_rust_label()
                );
                let collector: Arc<dyn adom_search::orchestrator::Collector> =
                    if native_collectors.len() == 1 {
                        native_collectors[0].clone()
                    } else {
                        Arc::new(adom_search::orchestrator::CompositeCollector::new(
                            native_collectors,
                        ))
                    };
                orch = orch.with_collector(collector);
            } else {
                eprintln!(
                    "[gateway] stream nativo sem INTERNAL_SEARCH_URL/JACKETT_TEST_TOKEN — coleta indisponível"
                );
            }
        }
    }
    let fallback: Option<Arc<dyn FallbackCheck>> =
        NodeInternalFallback::from_env().map(|fb| Arc::new(fb) as Arc<dyn FallbackCheck>);
    orch = orch.with_debrid(Arc::new(AdapterDebridFactory::new(None, fallback)));
    orch
}

/// Store da sombra: memória fresca — nunca [`open_swr_store`] / `STREAMS_DB`.
fn new_shadow_swr_store() -> Arc<dyn SwrStore> {
    Arc::new(MemorySwrStore::new())
}

/// Orquestrador da sombra (§9.1): compare-only.
///
/// - store **isolado em memória** — nunca abre `STREAMS_DB` (SWR hit / DELETE
///   de `get_with_stale` no SQLite do nativo furaria o compare-only);
/// - `shadow_mode` — não grava SWR, não promove, não revalida/tail em fundo;
/// - `NoDebridFactory` — sem check de debrid (nem reserva Node);
/// - `NoopTailEffects` — sem index-write / effects (mesmo com `with_routes`).
///
/// Não devolve nada ao cliente; o proxy só observa o corpo.
pub fn build_shadow_orchestrator() -> Orchestrator {
    let store = new_shadow_swr_store();
    let mut orch = Orchestrator::new(orchestrator_config_from_env(), store)
        .with_shadow_mode(true)
        .with_debrid(Arc::new(NoDebridFactory));
    let native = adom_search::orchestrator::try_sources_rust_native_from_env();
    let skip_sources: Vec<String> = native.iter().map(|(t, _)| t.to_string()).collect();
    let native_collectors: Vec<Arc<dyn adom_search::orchestrator::Collector>> =
        native.into_iter().map(|(_, c)| c).collect();
    match NodeRoutes::from_env() {
        Some(routes) => {
            let routes = Arc::new(routes);
            let node_collector = Arc::new(
                adom_search::orchestrator::NodeCollector::new(routes.clone())
                    .with_skip_sources(skip_sources.clone()),
            );
            let collector: Arc<dyn adom_search::orchestrator::Collector> =
                if native_collectors.is_empty() {
                    node_collector
                } else {
                    let mut all = native_collectors;
                    all.push(node_collector);
                    Arc::new(adom_search::orchestrator::CompositeCollector::new(all))
                };
            let collector = adom_search::orchestrator::wrap_collector_with_source_shadow(
                collector,
                Some(routes.clone() as Arc<dyn adom_search::orchestrator::InternalRoutes>),
            );
            orch = orch
                .with_collector(collector)
                .with_meta(Arc::new(NodeMetaSource::new(routes.clone())))
                .with_tail(Arc::new(NoopTailEffects))
                .with_internal_routes(routes);
        }
        None => {
            if !native_collectors.is_empty() {
                let collector: Arc<dyn adom_search::orchestrator::Collector> =
                    if native_collectors.len() == 1 {
                        native_collectors[0].clone()
                    } else {
                        Arc::new(adom_search::orchestrator::CompositeCollector::new(
                            native_collectors,
                        ))
                    };
                orch = orch
                    .with_collector(collector)
                    .with_tail(Arc::new(NoopTailEffects));
            } else {
                eprintln!(
                    "[gateway] stream-shadow sem INTERNAL_SEARCH_URL/JACKETT_TEST_TOKEN — coleta indisponível"
                );
            }
        }
    }
    orch
}

/// Rótulo de log dos collectors nativos ativos.
fn sources_rust_label() -> String {
    let mut active = Vec::new();
    for token in ["jackett", "prowlarr", "torrentio", "bludv", "mico"] {
        if sources_rust_includes(token) {
            active.push(token);
        }
    }
    if active.is_empty() {
        "SOURCES_RUST".to_string()
    } else {
        format!("SOURCES_RUST={}", active.join("+"))
    }
}

#[path = "stream_config.rs"]
mod stream_config;
pub use stream_config::*;

/// `true` para GET/HEAD em caminho `/stream/.../*.json` (com ou sem config).
pub fn is_native_stream(method: &Method, path: &str) -> bool {
    (*method == Method::GET || *method == Method::HEAD)
        && adom_search::parse_stream_path(path).is_some()
}

/// Responde o `/stream` pelo orquestrador. Nunca panic: falha de parse → 502;
/// falha de coleta vira lista/aviso 200 (contrato do orquestrador).
pub async fn handle(orch: &Orchestrator, req: Request<Body>) -> Response<Body> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let headers = req.headers().clone();
    let user_agent = header_str(&headers, USER_AGENT);
    let origin = request_origin(&headers);

    let Some(stream_req) =
        StreamRequest::from_path(&path, user_agent.as_deref(), origin.as_deref(), None)
    else {
        return bad_gateway();
    };

    let response = orch.handle(stream_req).await;
    stream_http_response(&method, &response)
}

fn stream_http_response(method: &Method, body: &StreamResponse) -> Response<Body> {
    let json = match serde_json::to_vec(body) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("[gateway] serialize stream: {err}");
            return bad_gateway();
        }
    };
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("Cache-Control", cache_control(body.cache_max_age))
        .body(Body::empty())
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from("bad_gateway"))
                .unwrap_or_else(|_| Response::new(Body::from("bad_gateway")))
        });
    if *method == Method::GET {
        *response.body_mut() = Body::from(json);
    }
    response
}

fn cache_control(max_age: u32) -> String {
    if max_age > 0 {
        format!(
            "max-age={max_age}, stale-while-revalidate={}, stale-if-error=86400, public",
            max_age.saturating_mul(4)
        )
    } else {
        "max-age=0, public".to_string()
    }
}

fn bad_gateway() -> Response<Body> {
    (
        StatusCode::BAD_GATEWAY,
        [(CONTENT_TYPE, "text/plain; charset=utf-8")],
        "bad_gateway",
    )
        .into_response()
}

fn header_str(headers: &HeaderMap, name: http::header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// Espelha `originOf` do Node: `PUBLIC_URL` do operador, senão Host validado.
///
/// `pub(crate)` para a sombra: o replay congelado tem que mascarar o MESMO
/// origin que o Node escreveu no corpo (Host puro divergiria com `PUBLIC_URL`).
pub(crate) fn request_origin(headers: &HeaderMap) -> Option<String> {
    if let Ok(url) = std::env::var("PUBLIC_URL") {
        let trimmed = url.trim().trim_end_matches('/');
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let host = headers.get(HOST)?.to_str().ok()?;
    if !is_safe_host(host) {
        return None;
    }
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|raw| raw.split(',').next().unwrap_or(raw).trim())
        .filter(|proto| *proto == "http" || *proto == "https")
        .unwrap_or("http");
    Some(format!("{scheme}://{host}"))
}

fn is_safe_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    // hostname[:port] ou [v6]:port — mesma intenção do ORIGIN_*_RE do Node.
    if host.starts_with('[') {
        return host
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || matches!(b, b'[' | b']' | b':' | b'.'));
    }
    host.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
}

#[cfg(test)]
#[path = "stream_tests.rs"]
mod tests;
