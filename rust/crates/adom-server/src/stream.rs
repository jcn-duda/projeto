//! Corte nativo de `/stream` (`ROUTES_RUST` contém o token exato `stream`).
//!
//! A COLETA é 100% nativa (`adom-sources`): Jackett, Prowlarr, Torrentio,
//! BLUDV e Mico. Metadados/efeitos/tail continuam no Node via
//! `POST /internal/search/*` (`InternalSearchClient` / `NodeRoutes`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::response::IntoResponse;
use http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE, HOST, USER_AGENT};
use http::{HeaderMap, Method, Request, Response, StatusCode};

use adom_search::orchestrator::{
    AdapterDebridFactory, Collector, CompositeCollector, InternalRoutes, NodeRoutes,
    NodeTailEffects, Orchestrator, StreamRequest,
};
use adom_search::{HoldsFeed, MemorySwrStore, NodeHoldsFeed, StreamResponse, SwrStore};
use adom_store::StreamsStore;

use crate::dub_audit::{DubAudit, DubAuditConfig};
use crate::dub_audit_writes::NativeWrites;
use crate::resolve_native::DebridPlay;
use crate::tail_effects::NativeTailEffects;

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

/// Store SWR do corte + handle CONCRETO do SQLite `streams.db`.
///
/// O orquestrador consome o `dyn SwrStore`; a API administrativa
/// (`store_admin`) precisa dos métodos por obra/hash/trace. Os dois apontam
/// para a MESMA instância: a invalidação vale para o SWR do processo na hora,
/// sem reabrir arquivo (e sem duas conexões escrevendo).
#[derive(Clone)]
pub struct StreamStores {
    pub swr: Arc<dyn SwrStore>,
    /// `None` só no fallback extremo (sem SQLite): a API fica sem alvo.
    pub streams: Option<Arc<StreamsStore>>,
}

/// Abre o `StreamsStore` de disco; se falhar, memória (+ log) — o boot não cai.
pub fn open_stream_stores() -> StreamStores {
    open_stream_stores_at(&streams_db_path())
}

fn open_stream_stores_at(path: &Path) -> StreamStores {
    match StreamsStore::open(path) {
        Ok(store) => {
            eprintln!("[gateway] streams store: {}", path.display());
            let store = Arc::new(store);
            StreamStores {
                swr: store.clone() as Arc<dyn SwrStore>,
                streams: Some(store),
            }
        }
        Err(err) => {
            eprintln!(
                "[gateway] streams.db indisponível ({}): {err}; usando memória",
                path.display()
            );
            match StreamsStore::open_memory() {
                Ok(store) => {
                    let store = Arc::new(store);
                    StreamStores {
                        swr: store.clone() as Arc<dyn SwrStore>,
                        streams: Some(store),
                    }
                }
                Err(mem_err) => {
                    eprintln!("[gateway] streams store memória falhou: {mem_err}; MemorySwrStore");
                    StreamStores {
                        swr: Arc::new(MemorySwrStore::new()),
                        streams: None,
                    }
                }
            }
        }
    }
}

/// Monta o orquestrador de produção: store SWR compartilhado, coletores
/// NATIVOS e debrid com reserva Node.
///
/// Falha de boot: se NENHUMA fonte nativa montar, devolve `Err` — o gateway
/// recusa subir em vez de responder lista vazia para sempre. Fonte que falha
/// sozinha loga `[search] <fonte> nativa indisponível` e fica fora (reduz
/// resultado, nunca derruba a busca). Metadados são nativos, com o Node de
/// FALLBACK; os efeitos de cauda continuam no Node quando as rotas existem.
pub fn build_orchestrator_from(stores: StreamStores) -> Result<Orchestrator, String> {
    let config = orchestrator_config_from_env();
    let StreamStores { swr, streams } = stores;
    let mut orch = Orchestrator::new(config, swr);
    // `raw:v1` do BLUDV: SÓ no caminho vivo. O store é o mesmo `cache.db` que
    // o Node usa (chave/valor idênticos).
    let raw_store = open_bludv_raw_store();
    let native = adom_search::orchestrator::try_native_collectors_with_bludv_store(raw_store);
    if native.is_empty() {
        return Err(
            "nenhuma fonte nativa montada (Jackett/Prowlarr/Torrentio/BLUDV/Mico): \
             collect indisponível"
                .to_string(),
        );
    }
    eprintln!("[gateway] collect nativo: {} fonte(s)", native.len());
    let collector: Arc<dyn Collector> = if native.len() == 1 {
        native.into_iter().next().expect("lista com uma fonte")
    } else {
        Arc::new(CompositeCollector::new(native))
    };
    orch = orch.with_collector(collector);
    match NodeRoutes::from_env() {
        Some(routes) => {
            let routes = Arc::new(routes);
            // C5: fonte nativa de metadados, com o Node de FALLBACK (rede
            // fora/título não resolvido).
            let meta = stream_meta::meta_source(Some(routes.clone() as Arc<dyn InternalRoutes>));
            // T3-L7a: o `dub_audit` passou a ser executado AQUI (fila + veredito
            // nativos, com as escritas em `mag`/`idx`/`adprot`/`streams`). O
            // alvo abaixo só recebe os efeitos que ainda são do Node.
            let audit = Arc::new(DubAudit::new(
                DubAuditConfig::from_env(),
                Arc::new(DebridPlay::new()),
                Arc::new(NativeWrites::from_env(streams.clone())),
            ));
            orch = orch
                .with_tail(Arc::new(NativeTailEffects::new(
                    Arc::new(NodeTailEffects::new(routes.clone())),
                    audit,
                )))
                .with_internal_routes(routes);
            if let Some(meta) = meta {
                orch = orch.with_meta(meta);
            }
        }
        None => {
            eprintln!("[gateway] sem rotas Node — tail indisponível; metadados só nativos");
            // C5: sem rotas internas o nativo é a única fonte de metadados
            // (Cinemeta/TMDB); não há para onde cair.
            if let Some(meta) = stream_meta::meta_source(None) {
                orch = orch.with_meta(meta);
            }
        }
    }
    orch = orch.with_debrid(Arc::new(
        AdapterDebridFactory::new(rd_ledger_store()).with_holds(holds_feed()),
    ));
    // Inventário nativo da conta (F3): é a ÚNICA fonte da conta no corte.
    eprintln!("[gateway] inventário da conta nativo");
    orch = orch.with_native_account();
    // F4.4a — `bad`/`lie` do banco de magnets da conta lidos DIRETO do
    // `cache.db` (namespace `mag:v1`). Com coleta/índice nativos o item não
    // passa pela rota de evidência do Node, e sem esta fonte hash que o play
    // provou quebrado voltava à lista até o TTL.
    match adom_store::MagnetDbStore::from_env() {
        Ok(store) => {
            eprintln!("[gateway] poda bad/lie do cache.db ativa (mag:v1)");
            orch = orch.with_known_broken(Arc::new(store));
        }
        Err(err) => eprintln!(
            "[gateway] cache.db indisponível para bad/lie ({err}); build segue sem a poda nativa"
        ),
    }
    Ok(wire_native_index(orch))
}

/// Store do ledger do Real-Debrid (`rdc:v2`) no MESMO `cache.db` do Node,
/// aberto READ-ONLY. Sem ele o `verdict` não tem de onde ler e todo hash do
/// RD sai `Unknown` — a lista perde o ⚡ sem nenhum erro.
///
/// A leitura é só leitura de propósito: o L1 do Node é a autoridade do
/// arquivo, não relê o disco depois do boot e o flush sobrescreveria a linha
/// do gateway. Quem renova o hit continua sendo o Node (warmer/play).
fn rd_ledger_store() -> Option<Arc<adom_debrid::Store>> {
    let path = adom_store::default_cache_db_path();
    match adom_debrid::Store::open_cache_db(&path) {
        Ok(store) => {
            eprintln!(
                "[gateway] ledger RD (rdc:v2) lido do cache.db: {}",
                path.display()
            );
            Some(Arc::new(store))
        }
        Err(err) => {
            eprintln!("[gateway] rdc:v2 indisponível ({err}); RD segue unknown");
            None
        }
    }
}

/// Feed dos holds do autofetch (`DEBRID_AL_HOLDS`, default OFF no código e ON
/// no compose). Sem a flag, sem token ou base fora do loopback é `None` — e a
/// checagem nativa da AllDebrid segue READ-ONLY (`holds_complete:false`).
fn holds_feed() -> Option<Arc<dyn HoldsFeed>> {
    let feed = NodeHoldsFeed::from_env()?;
    eprintln!(
        "[gateway] feed de holds do autofetch: DEBRID_AL_HOLDS=on \
         (/internal/debrid/holds; a limpeza nativa só age com DEBRID_AL_CLEANUP=on)"
    );
    Some(Arc::new(feed))
}

/// Abre e injeta o índice/banco nativos. Índice e banco são SEMPRE nativos
/// (R4): falha de abertura = instrumento ausente, nunca boot caído e nunca
/// caminho Node — o orquestrador degrada sem índice/banco (log `[search]`)
/// e a métrica `index.rust.source_missing` aparece no `/metrics`.
fn wire_native_index(orch: Orchestrator) -> Orchestrator {
    let cfg = orch.config().clone();
    let mut orch = orch;
    if cfg.release_index_enabled && cfg.release_index_ttl > 0 {
        match adom_store::NativeReleaseIndex::from_env() {
            Ok(store) => {
                eprintln!(
                    "[gateway] índice de releases nativo (idx:v14, ttl={}s, teto={})",
                    cfg.release_index_ttl, cfg.release_index_max_releases
                );
                orch = orch.with_index_source(Arc::new(
                    store.with_limits(cfg.release_index_ttl, cfg.release_index_max_releases),
                ));
            }
            Err(err) => {
                eprintln!("[search] idx:v14 indisponível ({err}); seguindo sem índice nativo")
            }
        }
    }
    if cfg.magnet_bank_enabled {
        match adom_store::MagnetBankStore::from_env() {
            Ok(store) => {
                eprintln!("[gateway] banco de magnets nativo (magnets.db)");
                orch = orch.with_bank_source(Arc::new(store));
            }
            Err(err) => {
                eprintln!("[search] magnets.db indisponível ({err}); seguindo sem banco nativo")
            }
        }
    }
    orch
}

/// Store do `raw:v1` compartilhado com o Node (`data/cache.db`), consumido
/// pelo coletor BLUDV nativo. Falha de abertura → `None` (o caminho vivo segue
/// sem cache bruto; a busca nunca cai).
fn open_bludv_raw_store() -> Option<Arc<dyn adom_search::RawStore>> {
    match adom_store::raw_store_from_env() {
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
