//! Corte nativo de `/stream` (`ROUTES_RUST` contém o token exato `stream`).
//!
//! Prioridade sobre `stream-shadow`: com o corte ligado o cliente NÃO passa pelo
//! Node nem pela sombra. A rede de coleta/metadados ainda mora no Node via
//! `POST /internal/search/*` (`InternalSearchClient` / `NodeRoutes`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::response::IntoResponse;
use bytes::Bytes;
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
    let config = orchestrator_config_from_env();
    let mut orch = Orchestrator::new(config, store);
    // `raw:v1` do BLUDV: SÓ no caminho vivo. O store é o mesmo `cache.db` que
    // o Node usa (chave/valor idênticos); a sombra nem o abre.
    let raw_store = open_bludv_raw_store();
    let native =
        adom_search::orchestrator::try_sources_rust_native_from_env_with_bludv_store(raw_store);
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
            // C5: `META_RUST` troca a fonte de metadados (Node é o default e o
            // fallback); `META_RUST_SHADOW` arma a comparação compare-only.
            let meta = stream_meta::meta_source(Some(
                routes.clone() as Arc<dyn adom_search::orchestrator::InternalRoutes>
            ));
            orch = orch
                .with_collector(collector)
                .with_tail(Arc::new(NodeTailEffects::new(routes.clone())))
                .with_internal_routes(routes);
            if let Some(meta) = meta {
                orch = orch.with_meta(meta);
            }
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
            // C5: sem rotas internas o `META_RUST` ainda entrega metadados ao
            // corte (Cinemeta/TMDB nativos); com a flag OFF nada muda.
            if let Some(meta) = stream_meta::meta_source(None) {
                orch = orch.with_meta(meta);
            }
        }
    }
    let fallback: Option<Arc<dyn FallbackCheck>> =
        NodeInternalFallback::from_env().map(|fb| Arc::new(fb) as Arc<dyn FallbackCheck>);
    let al_mode = adom_debrid::alldebrid_mode::AlRustMode::from_env();
    if al_mode != adom_debrid::alldebrid_mode::AlRustMode::Off {
        eprintln!(
            "[gateway] checagem AllDebrid nativa: DEBRID_AL_RUST={} ({}; \
             rollback: DEBRID_AL_RUST=off)",
            al_mode.as_str(),
            if al_mode == adom_debrid::alldebrid_mode::AlRustMode::Shadow {
                "nativa responde; Node é referência em fundo — sombra faz upload extra e não limpa"
            } else {
                "nativa responde; fallback Node só antes de qualquer upload"
            }
        );
    }
    orch = orch.with_debrid(Arc::new(AdapterDebridFactory::new(None, fallback)));
    // Inventário nativo da conta (F3). `ACCOUNT_RUST=off` (default) mantém
    // `None`: a coleta da conta continua na tarefa Node.
    if orch.config().account_mode.uses_native() {
        eprintln!(
            "[gateway] inventário da conta nativo: ACCOUNT_RUST={}",
            orch.config().account_mode.as_str()
        );
        orch = orch.with_native_account();
    }
    wire_native_index(orch)
}

/// Abre e injeta o índice/banco nativos quando `INDEX_RUST`/`BANK_RUST` pedem
/// (`on`/`shadow`). Falha de abertura = instrumento ausente, nunca boot caído:
/// o modo `on` degrada para o caminho Node e a métrica
/// `index.rust.source_missing` aparece no `/metrics`.
fn wire_native_index(orch: Orchestrator) -> Orchestrator {
    let cfg = orch.config().clone();
    let mut orch = orch;
    if cfg.index_mode.uses_native() && cfg.release_index_enabled && cfg.release_index_ttl > 0 {
        match adom_store::ReleaseIndexStore::from_env() {
            Ok(store) => {
                eprintln!(
                    "[gateway] índice de releases nativo: INDEX_RUST={} (idx:v14, ttl={}s, teto={})",
                    cfg.index_mode.as_str(),
                    cfg.release_index_ttl,
                    cfg.release_index_max_releases
                );
                orch = orch.with_index_source(Arc::new(
                    store.with_limits(cfg.release_index_ttl, cfg.release_index_max_releases),
                ));
            }
            Err(err) => eprintln!(
                "[gateway] idx:v14 indisponível ({err}); índice segue no Node mesmo com INDEX_RUST={}",
                cfg.index_mode.as_str()
            ),
        }
    }
    if cfg.bank_mode.uses_native() && cfg.magnet_bank_enabled {
        match adom_store::MagnetBankStore::from_env() {
            Ok(store) => {
                eprintln!(
                    "[gateway] banco de magnets nativo: BANK_RUST={} (magnets.db)",
                    cfg.bank_mode.as_str()
                );
                orch = orch.with_bank_source(Arc::new(store));
            }
            Err(err) => eprintln!(
                "[gateway] magnets.db indisponível ({err}); banco segue no Node mesmo com BANK_RUST={}",
                cfg.bank_mode.as_str()
            ),
        }
    }
    orch
}

/// Store do `raw:v1` compartilhado com o Node (`data/cache.db`), aberto só
/// quando o coletor BLUDV nativo está pedido. Falha de abertura → `None`
/// (o caminho vivo segue sem cache bruto; a busca nunca cai).
fn open_bludv_raw_store() -> Option<Arc<dyn adom_search::RawStore>> {
    if !sources_rust_includes("bludv") {
        return None;
    }
    match adom_store::RawCacheStore::from_env() {
        Ok(store) => {
            eprintln!(
                "[gateway] raw:v1 BLUDV no cache.db do Node (cota {})",
                store.quota()
            );
            Some(Arc::new(store))
        }
        Err(err) => {
            eprintln!("[gateway] raw:v1 indisponível ({err}); BLUDV sem cache bruto");
            None
        }
    }
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
    wire_native_index(orch)
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

#[path = "stream_meta.rs"]
mod stream_meta;

/// `true` para GET/HEAD em caminho `/stream/.../*.json` (com ou sem config).
pub fn is_native_stream(method: &Method, path: &str) -> bool {
    (*method == Method::GET || *method == Method::HEAD)
        && adom_search::parse_stream_path(path).is_some()
}

/// Responde o `/stream` pelo orquestrador e devolve também o corpo JSON REAL
/// (GET) — o canário direto compara esse corpo com o Node e os contadores
/// nativos o leem sem reserializar. HEAD devolve `None` (sem corpo). Nunca
/// panic: falha de parse → 502; falha de coleta vira lista/aviso 200 (contrato
/// do orquestrador).
pub async fn handle_with_body(
    orch: &Orchestrator,
    req: Request<Body>,
) -> (Response<Body>, Option<Bytes>) {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let headers = req.headers().clone();
    let user_agent = header_str(&headers, USER_AGENT);
    let origin = request_origin(&headers);

    let Some(stream_req) =
        StreamRequest::from_path(&path, user_agent.as_deref(), origin.as_deref(), None)
    else {
        return (bad_gateway(), None);
    };

    let response = orch.handle(stream_req).await;
    stream_http_response(&method, &response)
}

fn stream_http_response(method: &Method, body: &StreamResponse) -> (Response<Body>, Option<Bytes>) {
    let json = match serde_json::to_vec(body) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("[gateway] serialize stream: {err}");
            return (bad_gateway(), None);
        }
    };
    let payload = Bytes::from(json);
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
        *response.body_mut() = Body::from(payload.clone());
        (response, Some(payload))
    } else {
        (response, None)
    }
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
