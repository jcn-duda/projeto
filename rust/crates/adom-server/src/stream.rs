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
    AdapterDebridFactory, NodeRoutes, NoDebridFactory, NoopTailEffects, Orchestrator,
    OrchestratorConfig, StreamRequest,
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
                    eprintln!(
                        "[gateway] streams store memória falhou: {mem_err}; MemorySwrStore"
                    );
                    Arc::new(MemorySwrStore::new())
                }
            }
        }
    }
}

/// Monta o orquestrador de produção: store SWR compartilhado, coleta via
/// rotas internas (se `JACKETT_TEST_TOKEN` existir) e debrid com reserva Node.
pub fn build_orchestrator() -> Orchestrator {
    let store = open_swr_store();
    let mut orch = Orchestrator::new(orchestrator_config_from_env(), store);
    match NodeRoutes::from_env() {
        Some(routes) => {
            orch = orch.with_routes(Arc::new(routes));
        }
        None => {
            eprintln!(
                "[gateway] stream nativo sem INTERNAL_SEARCH_URL/JACKETT_TEST_TOKEN — coleta indisponível"
            );
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
    match NodeRoutes::from_env() {
        Some(routes) => {
            // `with_routes` liga NodeTailEffects — sobrescreve para noop.
            orch = orch
                .with_routes(Arc::new(routes))
                .with_tail(Arc::new(NoopTailEffects));
        }
        None => {
            eprintln!(
                "[gateway] stream-shadow sem INTERNAL_SEARCH_URL/JACKETT_TEST_TOKEN — coleta indisponível"
            );
        }
    }
    orch
}

/// Números do operador. Defaults do crate cobrem o boot; envs opcionais
/// ajustam prazo/TTL/segredo sem exigir o `.env` completo do Node.
fn orchestrator_config_from_env() -> OrchestratorConfig {
    let mut cfg = OrchestratorConfig::default();
    if let Ok(secret) = std::env::var("RESOLVE_SECRET") {
        cfg.resolve_secret = secret;
    }
    if let Some(ms) = env_u64("REPLY_DEADLINE_MS") {
        cfg.stremio_reply_ms = ms;
        cfg.budgets.reply_deadline_ms = ms as i64;
    }
    if let Some(ms) = env_u64("APP_REPLY_DEADLINE_MS") {
        cfg.app_reply_ms = ms;
    }
    if let Some(ttl) = env_i64("CACHE_TTL") {
        cfg.cache_ttl = ttl;
    }
    if let Some(ttl) = env_i64("FALLBACK_STREAMS_TTL") {
        cfg.fallback_streams_ttl = ttl;
    }
    if let Some(grace) = env_u64("STREAM_STALE_GRACE_SECONDS") {
        cfg.stale_grace_seconds = grace;
    }
    if let Ok(raw) = std::env::var("DEBRID_RESOLVE_UNCACHED") {
        cfg.resolve_uncached = matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "on" | "yes"
        );
    }
    cfg
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok()?.trim().parse().ok()
}

fn env_i64(key: &str) -> Option<i64> {
    std::env::var(key).ok()?.trim().parse().ok()
}

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
fn request_origin(headers: &HeaderMap) -> Option<String> {
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
        return host.bytes().all(|b| {
            b.is_ascii_hexdigit() || matches!(b, b'[' | b']' | b':' | b'.')
        });
    }
    host.bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_db_path_env_vence_default() {
        assert_eq!(
            streams_db_path_from(None),
            PathBuf::from(DEFAULT_STREAMS_DB)
        );
        assert_eq!(
            streams_db_path_from(Some("")),
            PathBuf::from(DEFAULT_STREAMS_DB)
        );
        assert_eq!(
            streams_db_path_from(Some("   ")),
            PathBuf::from(DEFAULT_STREAMS_DB)
        );
        assert_eq!(
            streams_db_path_from(Some("  custom/streams.db  ")),
            PathBuf::from("custom/streams.db")
        );
    }

    #[test]
    fn new_shadow_swr_store_memoria_vazia_nao_abre_disco() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("streams.db");
        let prev = std::env::var("STREAMS_DB").ok();
        // SAFETY: teste serial local; restaura STREAMS_DB ao sair.
        std::env::set_var("STREAMS_DB", &path);
        let store = new_shadow_swr_store();
        assert_eq!(store.len(), 0);
        let orch = build_shadow_orchestrator();
        assert!(orch.shadow_mode());
        assert!(
            !path.exists(),
            "shadow não deve chamar open_swr_store / criar STREAMS_DB"
        );
        match prev {
            Some(v) => std::env::set_var("STREAMS_DB", v),
            None => std::env::remove_var("STREAMS_DB"),
        }
    }

    #[test]
    fn open_swr_store_at_tempfile_abre() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("streams.db");
        let store = open_swr_store_at(&path);
        assert_eq!(store.len(), 0);
        assert!(path.is_file(), "open deve criar o arquivo em disco");
    }

    #[test]
    fn open_swr_store_at_path_invalido_cai_em_memoria() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Pai é arquivo → create_dir_all/open falha → fallback memória.
        let blocker = dir.path().join("nao-e-pasta");
        std::fs::write(&blocker, b"x").expect("blocker");
        let path = blocker.join("streams.db");
        let store = open_swr_store_at(&path);
        assert_eq!(store.len(), 0);
        assert!(!path.exists(), "fallback memória não cria o path inválido");
    }

    #[test]
    fn cache_control_zero_e_positivo() {
        assert_eq!(cache_control(0), "max-age=0, public");
        assert_eq!(
            cache_control(900),
            "max-age=900, stale-while-revalidate=3600, stale-if-error=86400, public"
        );
    }

    #[test]
    fn is_native_stream_so_get_head_em_path_stream() {
        assert!(is_native_stream(
            &Method::GET,
            "/stream/movie/tt0133093.json"
        ));
        assert!(is_native_stream(
            &Method::HEAD,
            "/e30/stream/series/tt0903747:1:1.json"
        ));
        assert!(!is_native_stream(
            &Method::POST,
            "/stream/movie/tt0133093.json"
        ));
        assert!(!is_native_stream(&Method::GET, "/manifest.json"));
        assert!(!is_native_stream(&Method::GET, "/health"));
    }

    #[test]
    fn from_path_sem_config_mantem_encoded_none_e_prefixo_vazio() {
        let req = StreamRequest::from_path("/stream/movie/tt0133093.json", None, None, None)
            .expect("path sem config");
        // Paridade Node: sem segmento na URL → prefixo ""; o canônico `e30`
        // só entra no corpo de `/internal/search/*` (orquestrador).
        assert_eq!(req.encoded, None);
        assert_eq!(req.prefix(), "");

        let com = StreamRequest::from_path(
            "/eyJwIjoiamFja2V0dCJ9/stream/movie/tt0133093.json",
            None,
            None,
            None,
        )
        .expect("path com config");
        assert_eq!(com.encoded.as_deref(), Some("eyJwIjoiamFja2V0dCJ9"));
        assert_eq!(com.prefix(), "/eyJwIjoiamFja2V0dCJ9");
    }
}
