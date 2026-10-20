//! Proxy reverso. O Host original segue intacto: o Node monta URL pública a
//! partir dele. Sem retry e sem prazo curto — o play e o portão passam de 30s.
//!
//! Com `ROUTES_RUST` contendo `stream`, o `/stream` é cortado no Rust
//! (orquestrador) e não chega ao upstream — a sombra também fica de fora.

use std::collections::BTreeMap;
use std::path::PathBuf;

use axum::body::Body;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{any, get};
use axum::Json;
use axum::Router;
use bytes::Bytes;
use http::header::{CONNECTION, CONTENT_TYPE, USER_AGENT};
use http::{HeaderMap, HeaderName, Method, Request, Response, StatusCode, Uri};
use http_body_util::BodyExt;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

use adom_search::orchestrator::Orchestrator;

use crate::canary::Canary;
use crate::config::Config;
use crate::resolve::{self, GateDecision};
use crate::shadow::{self, ShadowMetrics, ShadowRemount, ShadowRequest};
use crate::stream;

pub type ProxyClient = Client<HttpConnector, Body>;

#[derive(Clone)]
pub struct AppState {
    pub client: ProxyClient,
    pub upstream: Uri,
    pub native_health: bool,
    pub stream_shadow: bool,
    /// Corte nativo: quando true e há orquestrador, `/stream` não vai ao Node.
    pub stream_native: bool,
    /// Guarda HMAC de `/resolve` (`ROUTES_RUST=resolve`).
    pub resolve_native: bool,
    /// Após verify OK: proxy ao Node. `false` → 501 (sem play / sem debrid).
    pub resolve_proxy: bool,
    /// `RESOLVE_SECRET` — precedência sobre `dk` da URL no HMAC.
    pub resolve_secret: String,
    pub shadow_metrics: ShadowMetrics,
    /// Store SWR + deps compartilhados entre requisições. `None` com a flag
    /// desligada (ou teste sem corte).
    pub orchestrator: Option<Orchestrator>,
    /// Remontador da sombra (`stream-shadow`). `None` sem token/env — observe
    /// pula sem falso divergence. Independente do `orchestrator` do corte.
    pub shadow_remount: Option<ShadowRemount>,
    /// `STREAM_SHADOW_MODE=direct`: compara o corpo normal do Node com a
    /// remontagem, sem passar pela captura congelada (F4.3).
    pub shadow_direct: bool,
    /// Canário do corte (F4.2/F4.3): amostra determinística + comparação em
    /// paralelo (congelada ou direta). Default 0 (OFF); não altera a resposta.
    pub canary: Canary,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/metrics", get(metrics_snapshot))
        .fallback(any(dispatch))
        .with_state(state)
}

/// Snapshot §9 — só contadores, sem token/credencial. Inclui as métricas da
/// sombra de FONTE (`source.shadow.*`), as do inventário nativo da conta
/// (`account.*`, F3) e as do canário do corte (`stream.canary.*`).
async fn metrics_snapshot(State(state): State<AppState>) -> Json<BTreeMap<String, u64>> {
    let mut snapshot = state.shadow_metrics.snapshot();
    snapshot.extend(adom_search::orchestrator::source_shadow_metrics_snapshot());
    snapshot.extend(adom_search::orchestrator::account_metrics_snapshot());
    // Sombra de METADADOS (C5): namespace próprio `meta.shadow.*`.
    snapshot.extend(adom_search::orchestrator::meta_shadow_metrics_snapshot());
    // Índice/banco nativos (F4.5): `index.*`/`bank.*`.
    snapshot.extend(adom_search::orchestrator::index_metrics_snapshot());
    snapshot.extend(state.canary.metrics().snapshot());
    Json(snapshot)
}

pub fn client() -> ProxyClient {
    Client::builder(TokioExecutor::new()).build(HttpConnector::new())
}

pub async fn run(config: Config) -> Result<(), String> {
    let listen = config.listen;
    let native = config.native_health;
    let shadow = config.stream_shadow;
    let stream_cut = config.stream_native;
    let resolve_cut = config.resolve_native;
    let resolve_proxy = config.resolve_proxy;
    let upstream = config.upstream.clone();
    let orchestrator = if stream_cut {
        Some(stream::build_orchestrator())
    } else {
        None
    };
    // Sombra só quando o corte NÃO engole a rota; sem token → None (pula).
    // `STREAM_SHADOW_MODE=direct` não monta a captura: compara o corpo normal
    // com a remontagem (o remount pode existir ou não; sem token, pula).
    let shadow_direct = shadow::direct_from_env();
    let shadow_remount = if shadow && !stream_cut {
        shadow::remount_from_env()
    } else {
        None
    };
    if shadow && shadow_direct {
        eprintln!("[gateway] stream-shadow em modo DIRETO (sem captura congelada)");
        if shadow_remount.is_none() {
            eprintln!(
                "[gateway] stream-shadow direto sem INTERNAL_SEARCH_URL/JACKETT_TEST_TOKEN — comparações puladas"
            );
        }
    }
    // Canário do corte: só lê a env quando o token `stream` está ligado.
    let canary = Canary::from_env(stream_cut);
    if canary.percent() > 0 {
        eprintln!(
            "[gateway] canary corte: {}% modo={} (amostra determinística por path)",
            canary.percent(),
            canary.mode().label()
        );
        if canary.mode() == crate::canary::Mode::Frozen && canary.frozen_base().is_none() {
            eprintln!(
                "[gateway] canary corte sem STREAM_FROZEN_SHADOW_BASE — amostras puladas (não há captura)"
            );
        }
    }
    let state = AppState {
        client: client(),
        upstream: config.upstream,
        native_health: config.native_health,
        stream_shadow: config.stream_shadow,
        stream_native: stream_cut,
        resolve_native: resolve_cut,
        resolve_proxy,
        resolve_secret: config.resolve_secret,
        shadow_metrics: ShadowMetrics::new(),
        orchestrator,
        shadow_remount,
        shadow_direct,
        canary,
    };
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|err| format!("nao escutei {listen}: {err}"))?;
    let bound = listener
        .local_addr()
        .map_err(|err| format!("endereco local: {err}"))?;
    eprintln!(
        "[gateway] escutando {bound} upstream {upstream} health_nativo={native} stream_shadow={shadow} stream_native={stream_cut} resolve_native={resolve_cut} resolve_proxy={resolve_proxy}"
    );
    axum::serve(listener, router(state))
        .await
        .map_err(|err| format!("servidor encerrou: {err}"))
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
    // Corte nativo TEM prioridade sobre stream-shadow: sem proxy, sem sombra.
    if state.stream_native && stream::is_native_stream(req.method(), req.uri().path()) {
        return match &state.orchestrator {
            Some(orch) => {
                // Planeja a amostra ANTES de mover `req` para o handler. A
                // resposta do corte sai igual; a comparação roda em
                // `tokio::spawn` e nunca segura o cliente.
                let canary_plan = state.canary.plan(&req, &state.upstream);
                // O corpo REAL do corte (GET) alimenta o canário direto e os
                // contadores nativos; a resposta devolvida é a mesma.
                let (response, body) = stream::handle_with_body(orch, req).await;
                if let Some(plan) = canary_plan {
                    state.canary.spawn(plan, body);
                } else {
                    state.canary.observe_cut(body.as_deref());
                }
                response
            }
            None => (
                StatusCode::BAD_GATEWAY,
                [(CONTENT_TYPE, "text/plain; charset=utf-8")],
                "bad_gateway",
            )
                .into_response(),
        };
    }
    // Guarda HMAC do play: verify no Rust; play real só via proxy (strangler).
    // Nunca chama debrid aqui — evita segundo upload.
    if state.resolve_native && resolve::is_native_resolve(req.method(), req.uri().path()) {
        let (path, query) = resolve::path_and_query(&req);
        match resolve::decide(path, query, &state.resolve_secret, state.resolve_proxy) {
            GateDecision::BadHash => return resolve::bad_hash_response(),
            GateDecision::Forbidden => return resolve::forbidden_response(),
            GateDecision::NotImplemented => return resolve::not_implemented_response(),
            GateDecision::Proxy => { /* cai no forward abaixo */ }
        }
    }
    let shadow = state.stream_shadow && shadow::is_stream_path(req.uri().path());
    match forward(&state, req, shadow).await {
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

async fn forward(
    state: &AppState,
    req: Request<Body>,
    capture_for_shadow: bool,
) -> Result<Response<Body>, ()> {
    let (req_parts, body) = req.into_parts();
    let path = req_parts
        .uri
        .path_and_query()
        .map(|item| item.as_str())
        .unwrap_or("/");
    // Id da captura congelada: gerado AQUI e usado só pela SEGUNDA request
    // (frozen), feita em `shadow::observe_node_response`. A request normal do
    // cliente NÃO grava dir — ela pode vir do SWR/fast-path e não é
    // reproduzível a partir das entradas.
    let shadow_id = if capture_for_shadow {
        Some(new_shadow_id())
    } else {
        None
    };
    let mut headers = forward_headers(&req_parts.headers);
    // Os headers da sombra são do gateway; cliente não os atravessa (nem na
    // request normal, nem forjando a captura).
    headers.remove(HeaderName::from_static(shadow::SHADOW_ID_HEADER));
    headers.remove(HeaderName::from_static(shadow::SHADOW_FROZEN_HEADER));
    let shadow_req = if capture_for_shadow {
        Some(ShadowRequest {
            path: req_parts.uri.path().to_string(),
            user_agent: header_text(&req_parts.headers, &USER_AGENT),
            origin: shadow_origin(&req_parts.headers),
            shadow_id,
            frozen_base: frozen_shadow_base(),
            // `STREAM_SHADOW_MODE=direct` desliga a captura congelada nesta
            // sombra; o `observe_node_response` usa a remontagem (item 2).
            direct: state.shadow_direct,
            // A segunda request herda Host/UA/accept da original para o Node
            // calcular o MESMO `originOf` (a máscara §9 casa `{{base}}`).
            headers: headers.clone(),
            node_base: state.upstream.clone(),
        })
    } else {
        None
    };
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

    if let Some(shadow_req) = shadow_req {
        let bytes: Bytes = incoming.collect().await.map_err(|_| ())?.to_bytes();
        let status = res_parts.status;
        let metrics = state.shadow_metrics.clone();
        let remount = state.shadow_remount.clone();
        let for_shadow = bytes.clone();
        // Fire-and-forget: falha/atraso da sombra não afeta o cliente.
        tokio::spawn(async move {
            shadow::observe_node_response(status, for_shadow, shadow_req, metrics, remount).await;
        });
        let mut out = Response::new(Body::from(bytes));
        *out.status_mut() = res_parts.status;
        *out.headers_mut() = headers;
        return Ok(out);
    }

    let mut out = Response::new(Body::from_stream(incoming.into_data_stream()));
    *out.status_mut() = res_parts.status;
    *out.headers_mut() = headers;
    Ok(out)
}

fn header_text(headers: &HeaderMap, name: &HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// Origin da sombra: o MESMO `originOf` do Node (`PUBLIC_URL` do operador e,
/// senão, Host validado). A comparação congelada mascara o host, mas precisa
/// mascarar EXATAMENTE o que o Node escreveu no corpo — Host puro divergiria
/// de `PUBLIC_URL` atrás do proxy.
fn shadow_origin(headers: &HeaderMap) -> Option<String> {
    stream::request_origin(headers)
}

/// Id curto e único por requisição sombreada (`X-Adom-Shadow-Id`). Sem
/// dependência de uuid: timestamp + contador, hexadecimal (nome de diretório
/// seguro e ordenável).
pub(crate) fn new_shadow_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{:x}-{:03x}-{:x}",
        now.as_secs(),
        now.subsec_millis(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// Raiz da captura congelada (`STREAM_FROZEN_SHADOW_BASE`), vazia → `None`.
/// Lida por requisição (env do processo, barata): o caminho congelado só age
/// quando o Node gravou `<base>/<id>` para esta sombra.
pub(crate) fn frozen_shadow_base() -> Option<PathBuf> {
    std::env::var("STREAM_FROZEN_SHADOW_BASE")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
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
