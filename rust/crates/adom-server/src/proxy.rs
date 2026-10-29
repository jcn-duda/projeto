//! Proxy reverso. O Host original segue intacto: o Node monta URL pública a
//! partir dele. Sem retry e sem prazo curto — o play e o portão passam de 30s.
//!
//! Com `ROUTES_RUST` contendo `stream`, o `/stream` é cortado no Rust
//! (orquestrador) e não chega ao upstream. O `/resolve` é nativo SEMPRE (fase C
//! do F4.7): não tem flag nem proxy de rollback.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{any, get};
use axum::Json;
use axum::Router;
use http::header::{CONNECTION, CONTENT_TYPE};
use http::{HeaderMap, HeaderName, Method, Request, Response, StatusCode, Uri};
use http_body_util::BodyExt;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

use adom_search::orchestrator::Orchestrator;

use crate::al_sweeps::{SweepAdmin, SweepRuntime};
use crate::config::Config;
use crate::resolve_bridge::PlayBridge;
use crate::resolve_native::{self, NativeContext, PlayResolver};
use crate::stream;

pub type ProxyClient = Client<HttpConnector, Body>;

#[derive(Clone)]
pub struct AppState {
    pub client: ProxyClient,
    pub upstream: Uri,
    pub native_health: bool,
    /// Corte nativo: quando true e há orquestrador, `/stream` não vai ao Node.
    pub stream_native: bool,
    /// `RESOLVE_SECRET` — precedência sobre `dk` da URL no HMAC.
    pub resolve_secret: String,
    /// Resolvedor do play nativo; teste injeta stub sem rede.
    pub resolver: Arc<dyn PlayResolver>,
    /// Ponte dos efeitos/fatos do play com o Node (`/internal/resolve/*`).
    pub bridge: Arc<dyn PlayBridge>,
    /// Store SWR + deps compartilhados entre requisições. `None` com a flag
    /// desligada (ou teste sem corte).
    pub orchestrator: Option<Orchestrator>,
    /// Epoch ms da última requisição `/stream` NATIVA. O colhedor usa como
    /// freio (`is_busy` = dentro de `HARVEST_IDLE_WINDOW_MS`).
    pub stream_traffic: Arc<AtomicI64>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/metrics", get(metrics_snapshot))
        .fallback(any(dispatch))
        .with_state(state)
}

/// Snapshot §9 — só contadores, sem token/credencial. Inclui as métricas do
/// inventário nativo da conta (`account.*`) e as do índice/banco nativos.
async fn metrics_snapshot() -> Json<BTreeMap<String, u64>> {
    let mut snapshot = adom_search::orchestrator::account_metrics_snapshot();
    // Checagem AllDebrid nativa (incondicional desde a R3): `debrid.al.*`.
    snapshot.extend(adom_search::orchestrator::debrid_al_metrics_snapshot());
    // Índice/banco nativos (F4.5): `index.*`/`bank.*`.
    snapshot.extend(adom_search::orchestrator::index_metrics_snapshot());
    // Metadados nativos × fallback Node (Fase 2): `meta.*`.
    snapshot.extend(adom_search::orchestrator::meta_metrics_snapshot());
    Json(snapshot)
}

/// Tempo que uma conexão OCIOSA fica no pool antes de ser descartada.
///
/// Tem que ficar ABAIXO do keep-alive do upstream: o http server do Node usa
/// 5 s (default), e o pool do hyper_util guarda 90 s. Com o painel fazendo poll
/// de 10 s, o Node fechava a conexão em 5 s e o gateway a reusava assim mesmo —
/// a requisição morria com `bad_gateway` (502 em ~100 ms, intermitente: 1 em
/// ~17 no `/dashboard-status.json`). É mais barato abrir uma conexão nova em
/// loopback do que retentar um request já escrito.
pub const POOL_IDLE: Duration = Duration::from_secs(2);

pub fn client() -> ProxyClient {
    client_with(POOL_IDLE)
}

/// `idle` é parâmetro para o teste de regressão: o pool curto deixa a
/// propriedade observável sem esperar os 2 s de produção.
pub fn client_with(idle: Duration) -> ProxyClient {
    Client::builder(TokioExecutor::new())
        .pool_idle_timeout(idle)
        .build(HttpConnector::new())
}

pub async fn run(config: Config) -> Result<(), String> {
    let listen = config.listen;
    let native = config.native_health;
    let stream_cut = config.stream_native;
    let upstream = config.upstream.clone();
    // F4.4a: o store do corte é aberto UMA vez e compartilhado com a API
    // administrativa (`streams.db`), para a invalidação do Node valer para o
    // SWR deste processo na hora.
    let stores = if stream_cut {
        Some(stream::open_stream_stores())
    } else {
        None
    };
    // Donos nativos de efeito: o canal do Chupim e o warmer do RD nascem ANTES
    // do orquestrador porque o tail é construído junto com ele. Sem
    // `AUTOFETCH_WORKER=on` o handle é `prepared` e `RD_WARM` desligado devolve
    // `None` — nos dois casos o efeito segue ao Node, como antes.
    // Freio do colhedor e do warmer: o `dispatch` marca AQUI (uma vez por
    // requisição do `/stream` nativo); os dois leem via `TrafficSense`.
    let stream_traffic = Arc::new(AtomicI64::new(0));
    let warmer = crate::rd_warmer::register(Some(stream_traffic.clone()));
    let autofetch = crate::autofetch::spawn();
    // Varreduras da AllDebrid: o gateway é o DONO ÚNICO do spawn (o `main` não
    // monta mais nada). O runtime vive até o fim do `serve`; a admin 8711
    // recebe só o `SweepAdmin` (modo, contadores e o sweeper compartilhado).
    let sweeps: SweepRuntime = crate::al_sweeps::spawn();
    // Falha de boot da coleta nativa (nenhuma fonte montada) é erro VISÍVEL:
    // `main` loga e sai — nunca queda silenciosa para uma lista vazia.
    let orchestrator = stores
        .as_ref()
        .map(|stores| {
            stream::build_orchestrator_from(stores.clone(), autofetch.clone(), warmer.clone())
        })
        .transpose()?;
    // Colhedor nativo (Fase 5): só existe com o corte nativo e orquestrador.
    // `None` não impede o gateway — as rotas `/harvest*` respondem desligado.
    let harvest = orchestrator.as_ref().and_then(|orch| {
        crate::harvest::spawn(
            orch,
            stream_traffic.clone(),
            stores.as_ref().and_then(|stores| stores.streams.clone()),
        )
    });
    // O colhedor nasce DEPOIS do worker: o slot do handle é preenchido aqui,
    // uma vez. Sem colhedor a sonda dirigida volta ao Node (o canal recusa).
    if let (Some(worker), Some(harvester)) = (autofetch.as_ref(), harvest.as_ref()) {
        worker.set_harvest(harvester.clone());
    }
    if let (Some(stores), Some(orch)) = (stores.as_ref(), orchestrator.as_ref()) {
        spawn_store_admin(
            stores,
            orch.config().stale_grace_seconds,
            harvest,
            autofetch,
            Some(sweeps.admin.clone()),
            warmer.clone(),
        );
    }
    let state = AppState {
        client: client(),
        upstream: config.upstream,
        native_health: config.native_health,
        stream_native: stream_cut,
        resolve_secret: config.resolve_secret,
        resolver: Arc::new(resolve_native::DebridPlay::new()),
        // O play é sempre nativo: a ponte com o Node é o caminho de produção.
        bridge: crate::resolve_bridge::from_env(),
        orchestrator,
        stream_traffic,
    };
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|err| format!("nao escutei {listen}: {err}"))?;
    let bound = listener
        .local_addr()
        .map_err(|err| format!("endereco local: {err}"))?;
    eprintln!(
        "[gateway] escutando {bound} upstream {upstream} health_nativo={native} stream_native={stream_cut} resolve_nativo=sempre"
    );
    axum::serve(listener, router(state))
        .await
        .map_err(|err| format!("servidor encerrou: {err}"))
}

/// Sobe a API administrativa do `streams.db`, do colhedor e do warmer (loopback
/// + token) em segundo plano. Falha de bind é só log: o `/stream` não depende
/// dela, e as chamadas do Node degradam para "sem efeito" (o Node loga e segue).
fn spawn_store_admin(
    stores: &stream::StreamStores,
    grace_seconds: u64,
    harvest: Option<crate::harvest::HarvestHandle>,
    autofetch: Option<crate::autofetch::AutofetchHandle>,
    sweeps: Option<SweepAdmin>,
    warmer: Option<Arc<crate::rd_warmer::Warmer>>,
) {
    let Some(streams) = stores.streams.clone() else {
        eprintln!("[gateway] streams admin sem store SQLite (memória); invalidação indisponível");
        return;
    };
    let cfg = match crate::store_admin::config_from_env() {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("[gateway] {err}; API do streams.db não sobe");
            return;
        }
    };
    tokio::spawn(async move {
        if let Err(err) = crate::store_admin::serve(
            cfg,
            streams,
            grace_seconds,
            harvest,
            autofetch,
            sweeps,
            warmer,
        )
        .await
        {
            eprintln!("[gateway] {err}");
        }
    });
}

async fn dispatch(State(state): State<AppState>, req: Request<Body>) -> Response<Body> {
    // O gateway é a FACHADA pública: `/internal/*` é a superfície que o Node
    // expõe só em loopback para o orquestrador Rust. Se a 7000 for exposta
    // direto, o socket do Node continua 127.0.0.1 (o proxy é local) e a guarda
    // de loopback não vê o cliente real — por isso a recusa tem que ser aqui,
    // antes do encaminhamento. O Caddy também barra `/internal/*`, mas essa é a
    // segunda linha, não a única. Qualquer peer, inclusive loopback, é recusado:
    // o orquestrador fala com o Node direto, nunca através desta porta.
    if is_internal_path(req.uri().path()) {
        return (
            StatusCode::FORBIDDEN,
            [(CONTENT_TYPE, "application/json; charset=utf-8")],
            r#"{"ok":false,"error":"rota interna nao servida pelo gateway"}"#,
        )
            .into_response();
    }
    if state.native_health && is_native_health(&req) {
        return health_response(req.method());
    }
    // Corte nativo: o `/stream` não passa pelo Node.
    if state.stream_native && stream::is_native_stream(req.method(), req.uri().path()) {
        // Marca o uso ANTES de atender: o colhedor só trabalha na janela de
        // idle. É a ÚNICA escrita que o colhedor faz neste caminho.
        state
            .stream_traffic
            .store(adom_sources::now_ms(), Ordering::Relaxed);
        return match &state.orchestrator {
            Some(orch) => stream::handle(orch, req).await,
            None => (
                StatusCode::BAD_GATEWAY,
                [(CONTENT_TYPE, "text/plain; charset=utf-8")],
                "bad_gateway",
            )
                .into_response(),
        };
    }
    // `/resolve` é nativo SEMPRE (fase C do F4.7): HMAC + adaptador AQUI, sem
    // flag. Erro do adaptador vira o status/texto do Node — não cai no proxy
    // (segundo upload mascararia o 502 do AllDebrid, por exemplo).
    if resolve_native::is_native_resolve(req.method(), req.uri().path()) {
        let ctx = NativeContext {
            resolve_secret: state.resolve_secret.clone(),
            resolver: state.resolver.clone(),
            bridge: state.bridge.clone(),
        };
        // Path/query viram donos: o `Request` não fica vivo através do await
        // (o body não é `Sync` e o handler precisa de future `Send`).
        let path = req.uri().path().to_string();
        let query = req.uri().query().map(str::to_string);
        return resolve_native::handle(&path, query.as_deref(), &ctx).await;
    }
    match forward(&state, req).await {
        Ok(response) => response,
        Err(()) => (
            StatusCode::BAD_GATEWAY,
            [(CONTENT_TYPE, "text/plain; charset=utf-8")],
            "bad_gateway",
        )
            .into_response(),
    }
}

/// `/internal` exato ou qualquer subcaminho: prefixo com barra para não
/// confundir `/internalfoo` com a superfície interna.
pub fn is_internal_path(path: &str) -> bool {
    path == "/internal" || path.starts_with("/internal/")
}

fn is_native_health(req: &Request<Body>) -> bool {
    let path = req.uri().path();
    path == "/health" && (*req.method() == Method::GET || *req.method() == Method::HEAD)
}

fn health_response(method: &Method) -> Response<Body> {
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::empty())
        .expect("resposta de health valida");
    if *method == Method::GET {
        *response.body_mut() = Body::from(r#"{"ok":true}"#);
    }
    response
}

async fn forward(state: &AppState, req: Request<Body>) -> Result<Response<Body>, ()> {
    let (req_parts, body) = req.into_parts();
    let path = req_parts
        .uri
        .path_and_query()
        .map(|item| item.as_str())
        .unwrap_or("/");
    let headers = forward_headers(&req_parts.headers);
    let uri = upstream_uri(&state.upstream, path)?;
    let mut upstream_req = Request::builder()
        .method(req_parts.method)
        .uri(uri)
        .body(body)
        .map_err(|_| ())?;
    *upstream_req.headers_mut() = headers;
    let response = state.client.request(upstream_req).await.map_err(|_| ())?;
    let (res_parts, incoming) = response.into_parts();
    let headers = forward_headers(&res_parts.headers);

    let mut out = Response::new(Body::from_stream(incoming.into_data_stream()));
    *out.status_mut() = res_parts.status;
    *out.headers_mut() = headers;
    Ok(out)
}

pub fn upstream_uri(base: &Uri, path_and_query: &str) -> Result<Uri, ()> {
    let scheme = base.scheme_str().ok_or(())?;
    let authority = base.authority().ok_or(())?.as_str();
    let path = if path_and_query.is_empty() {
        "/"
    } else {
        path_and_query
    };
    format!("{scheme}://{authority}{path}")
        .parse()
        .map_err(|_| ())
}

pub(crate) fn forward_headers(headers: &HeaderMap) -> HeaderMap {
    let extra = connection_names(headers);
    let mut out = HeaderMap::new();
    for (name, value) in headers {
        if is_hop(name) || extra.iter().any(|item| item == name) {
            continue;
        }
        out.append(name, value.clone());
    }
    out
}

fn connection_names(headers: &HeaderMap) -> Vec<HeaderName> {
    let Some(value) = headers.get(CONNECTION) else {
        return Vec::new();
    };
    let Ok(text) = value.to_str() else {
        return Vec::new();
    };
    text.split(',')
        .filter_map(|part| HeaderName::from_bytes(part.trim().as_bytes()).ok())
        .collect()
}

fn is_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-connection"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
    )
}
