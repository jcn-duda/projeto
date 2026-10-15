//! Servidor HTTP dos resolvers BR (axum).
//!
//! Mesmo contrato do `resolvers/resolver-http.ts`: rotas /health, /search,
//! /resolve, /dl e /api. Callbacks injetados via traits para que cada perfil
//! (tdf, nerd, bludv, etc.) passe sua lógica específica.

use axum::{
    extract::{Query, State},
    http::{StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::Deserialize;
use std::{net::SocketAddr, sync::Arc};
use tokio::net::TcpListener;

// ── Tipos de fronteira (callbacks) ──────────────────────────────────────────

/// Resultado de busca — cada perfil tipa os itens do seu jeito.
/// O TS usa `unknown[]`; aqui `serde_json::Value` permite flexibilidade.
pub type SearchItems = Vec<serde_json::Value>;

/// Semente de unwrap do /resolve (parâmetros i/h/n aninhados na URL).
#[derive(Debug, Clone)]
pub struct UnwrapSeed {
    pub index: Option<String>,
    pub hash: Option<String>,
    pub count: Option<String>,
}

/// URL desenrolada (após unwrap de aninhamentos).
#[derive(Debug, Clone)]
pub struct UnwrappedUrl {
    pub url: String,
    pub index: Option<usize>,
    pub hash: Option<String>,
    pub count: Option<String>,
}

/// Traits de callbacks injetados (um perfil implementa para passar sua lógica).
///
/// O TS recebe funções por factory; aqui usamos trait async para flexibilidade.
/// Cada perfil (tdf, nerd, bludv, etc.) implementa `ResolverCallbacks` com sua
/// lógica específica de busca, render e resolução.
#[async_trait::async_trait]
pub trait ResolverCallbacks: Send + Sync + 'static {
    /// Busca itens (query vazia = browse, decisão do perfil).
    async fn search(&self, q: &str) -> Result<SearchItems, String>;

    /// Renderiza HTML dos itens (para /search).
    fn render_html(&self, items: &SearchItems) -> String;

    /// Resolve melhor magnet (quando não há índice específico).
    async fn resolve_best(&self, url: &str) -> Result<String, String>;

    /// Resolve magnet de botão específico (índice + hash + count).
    async fn resolve_button(
        &self,
        url: &str,
        index: usize,
        hash: Option<&str>,
        count: Option<&str>,
    ) -> Result<String, String>;

    /// Resolve o portão DIRETO: `gate_url` é o botão do portão e `post_url` o
    /// post que o nomeia — contrato do executor do raspador no /resolve
    /// (`url=<botão>&p=<post>`). Default é erro: só perfil com portão
    /// sobrescreve (hoje, o bludv); a validação e o cache ficam no perfil.
    async fn resolve_gate_direct(
        &self,
        _gate_url: &str,
        _post_url: &str,
    ) -> Result<String, String> {
        Err("gate indisponivel neste perfil".to_string())
    }

    /// Desenrola URL aninhada (extrai i/h/n).
    fn unwrap_resolver_url(&self, value: &str, seed: UnwrapSeed) -> Result<UnwrappedUrl, String>;

    /// XML de capabilities (para /api?t=caps).
    fn caps_xml(&self) -> String;

    /// XML vazio (feed sem query, categoria por perfil).
    fn empty_xml(&self, category: u32, type_: &str) -> String;

    /// Renderiza XML torznab dos itens.
    fn render_xml(&self, items: &SearchItems, category: u32) -> String;

    /// Se true, /resolve valida índice (tdf/nerd); se false, deixa passar (comando/vaca).
    fn validate_index(&self) -> bool {
        false
    }

    /// Rotas que o profile TS registra (`createResolverRouter`): o resto é 404.
    fn routes(&self) -> RouteSet {
        RouteSet::ALL
    }

    /// Query do `/api` que vira feed vazio. O nerd decide pela query JÁ
    /// normalizada (`handleApi` próprio); os demais pela crua (`createApiRoute`).
    fn api_query_is_empty(&self, q: &str) -> bool {
        q.trim().is_empty()
    }
}

/// Rotas opcionais de um profile (`/health` e `/search` existem em todos).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteSet {
    pub resolve: bool,
    pub dl: bool,
    pub api: bool,
}

impl RouteSet {
    pub const ALL: Self = Self {
        resolve: true,
        dl: true,
        api: true,
    };
}

// ── Config do resolver ──────────────────────────────────────────────────────

/// Configuração do servidor resolver (porta + callbacks do perfil).
pub struct ResolverConfig {
    pub port: u16,
    pub site_name: String,
    pub callbacks: Arc<dyn ResolverCallbacks>,
}

// ── Handlers das rotas ──────────────────────────────────────────────────────

/// GET /health → 200 "ok" (text/plain).
async fn health_handler() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

/// Query params de /search.
#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
}

/// GET /search?q= → HTML do card Cardigann.
///
/// Query vazia (browse) NÃO é atalho: quem decide é o `search(q)` do perfil.
/// Erro da busca é 502 com a mensagem original (Jackett precisa da causa).
async fn search_handler(
    State(callbacks): State<Arc<dyn ResolverCallbacks>>,
    Query(params): Query<SearchQuery>,
) -> Response {
    let q = params.q.unwrap_or_default();
    match callbacks.search(&q).await {
        Ok(items) => {
            let html = callbacks.render_html(&items);
            (
                StatusCode::OK,
                [("content-type", "text/html; charset=utf-8")],
                html,
            )
                .into_response()
        }
        Err(msg) => (StatusCode::BAD_GATEWAY, msg).into_response(),
    }
}

// ── Rota /resolve (portão) ──────────────────────────────────────────────────

/// Rota /resolve extraída para arquivo próprio (catraca de 400 linhas). Os
/// símbolos do contrato do portão são reexportados: `gate_resolve.rs` e o
/// prefetch consomem por `crate::server::*`, como sempre. `#[path]` explícito:
/// o arquivo vive no nível de `src/`, não sob `src/server/`.
#[path = "gate_route.rs"]
mod gate_route;
pub use gate_route::{gate_wait_block_requested, with_gate_wait_block, GATE_PENDING};

/// Query params de /dl.
#[derive(Deserialize)]
struct DlQuery {
    url: Option<String>,
    i: Option<String>,
    h: Option<String>,
    n: Option<String>,
}

/// GET /dl?url=&i=&h=&n= → 302 Location: magnet.
///
/// Validação dura (invalid_params → 400) porque esta rota é consumida por
/// redirect direto do cardigann, sem corpo para explicar erro.
async fn dl_handler(
    State(callbacks): State<Arc<dyn ResolverCallbacks>>,
    Query(params): Query<DlQuery>,
) -> Response {
    let post_url = match params.url {
        Some(u) if !u.is_empty() && u.len() <= 4096 => u,
        _ => return (StatusCode::BAD_REQUEST, "invalid_params").into_response(),
    };

    // Índice é obrigatório e deve ser integer >= 0.
    let index_str = match params.i {
        Some(i) => i,
        None => return (StatusCode::BAD_REQUEST, "invalid_params").into_response(),
    };
    let index: usize = match index_str.parse() {
        Ok(i) => i,
        Err(_) => return (StatusCode::BAD_REQUEST, "invalid_params").into_response(),
    };

    match callbacks
        .resolve_button(&post_url, index, params.h.as_deref(), params.n.as_deref())
        .await
    {
        Ok(magnet) => Response::builder()
            .status(StatusCode::FOUND)
            .header("Location", magnet)
            .header("Cache-Control", "no-store")
            .body(axum::body::Body::empty())
            .unwrap(),
        Err(msg) => (StatusCode::BAD_GATEWAY, msg).into_response(),
    }
}

/// Query params de /api.
#[derive(Deserialize)]
struct ApiQuery {
    t: Option<String>,
    q: Option<String>,
}

/// GET /api?t=&q= → XML torznab.
///
/// t=caps: caps XML.
/// t fora de search/movie/tvsearch: 400 "unsupported_t".
/// Query vazia: feed vazio (categoria por profile).
/// Erro: 502 com mensagem.
async fn api_handler(
    State(callbacks): State<Arc<dyn ResolverCallbacks>>,
    Query(params): Query<ApiQuery>,
) -> Response {
    let type_ = params.t.unwrap_or_else(|| "caps".to_string());

    if type_ == "caps" {
        return (
            StatusCode::OK,
            [("content-type", "application/xml; charset=utf-8")],
            callbacks.caps_xml(),
        )
            .into_response();
    }

    if !["search", "movie", "tvsearch"].contains(&type_.as_str()) {
        return (StatusCode::BAD_REQUEST, "unsupported_t").into_response();
    }

    let category: u32 = if type_ == "tvsearch" { 5000 } else { 2000 };

    let q = params.q.unwrap_or_default();
    if callbacks.api_query_is_empty(&q) {
        return (
            StatusCode::OK,
            [("content-type", "application/xml; charset=utf-8")],
            callbacks.empty_xml(category, &type_),
        )
            .into_response();
    }

    match callbacks.search(&q).await {
        Ok(items) => {
            let xml = callbacks.render_xml(&items, category);
            (
                StatusCode::OK,
                [("content-type", "application/xml; charset=utf-8")],
                xml,
            )
                .into_response()
        }
        Err(msg) => (StatusCode::BAD_GATEWAY, msg).into_response(),
    }
}

/// Fallback para method/path desconhecido: 404 "not_found".
async fn fallback_handler(_uri: Uri) -> Response {
    (StatusCode::NOT_FOUND, "not_found").into_response()
}

// ── Construção do servidor ──────────────────────────────────────────────────

/// Monta o Router axum com todas as rotas do resolver.
pub fn build_router(callbacks: Arc<dyn ResolverCallbacks>) -> Router {
    let routes = callbacks.routes();
    let mut router = Router::new()
        .route("/health", get(health_handler))
        .route("/search", get(search_handler));
    // Rota que o profile TS não tem responde 404, não um 200 genérico.
    if routes.resolve {
        router = router.route("/resolve", get(gate_route::resolve_handler));
    }
    if routes.dl {
        router = router.route("/dl", get(dl_handler));
    }
    if routes.api {
        router = router.route("/api", get(api_handler));
    }
    router
        .fallback(get(fallback_handler))
        // Única linha de registro: toda rota de tráfego (search/resolve/dl/api)
        // marca atividade de usuário para o warm do FlareSolverr pular a vez
        // (flare_warm.rs). /health é tratado lá dentro (healthcheck ≠ usuário).
        .layer(axum::middleware::from_fn(
            crate::flare_warm::note_user_middleware,
        ))
        .with_state(callbacks)
}

/// Executa o servidor resolver na porta configurada.
///
/// Este é o ponto de entrada chamado pelo perfil (tdf, nerd, bludv, etc.).
/// O servidor sobe com tokio e aceita shutdown graceful via Ctrl+C.
pub async fn run_resolver(config: ResolverConfig) -> Result<(), Box<dyn std::error::Error>> {
    let callbacks = config.callbacks.clone();
    let app = build_router(callbacks);

    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let listener = TcpListener::bind(addr).await?;

    eprintln!("[resolver] {} ouvindo em http://{}", config.site_name, addr);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// Sinal de shutdown graceful (Ctrl+C).
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    eprintln!("[resolver] shutdown signal received");
}
