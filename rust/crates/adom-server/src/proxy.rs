//! Servidor da 7000: rotas portadas respondem aqui; o resto vai ao Node quando
//! há `GATEWAY_UPSTREAM` (proxy reverso, Host intacto, sem retry nem prazo
//! curto — o play passa de 30s) e, sem Node, responde 501.

use axum::body::Body;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::{any, get, post};
use axum::Router;
use http::header::{CONNECTION, CONTENT_TYPE};
use http::{HeaderMap, HeaderName, Method, Request, Response, StatusCode, Uri};
use http_body_util::BodyExt;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use crate::acervo::Acervo;
use crate::config::Config;
use crate::internal::{self, Internal, InternalState};

pub type ProxyClient = Client<HttpConnector, Body>;

#[derive(Clone)]
pub struct AppState {
    pub client: ProxyClient,
    pub upstream: Option<Uri>,
    pub native_health: bool,
    pub internal: InternalState,
}

pub fn router(state: AppState) -> Router {
    let internal = Router::new()
        .route("/internal/activity", get(internal::activity))
        .route("/internal/crawl-result", post(internal::crawl_result))
        .route("/acervo.json", get(internal::acervo))
        .with_state(state.internal.clone());
    internal.merge(Router::new().fallback(any(dispatch)).with_state(state))
}

pub fn client() -> ProxyClient {
    Client::builder(TokioExecutor::new()).build(HttpConnector::new())
}

pub async fn run(config: Config) -> Result<(), String> {
    let listen = config.listen;
    let native = config.native_health;
    let upstream = config
        .upstream
        .as_ref()
        .map_or("nenhum (só Rust)".to_string(), Uri::to_string);
    let acervo = Acervo::open(&config.acervo_path)?;
    let state = AppState {
        client: client(),
        upstream: config.upstream,
        native_health: config.native_health,
        internal: Arc::new(Internal {
            token: config.token,
            acervo,
            last_user_ms: AtomicI64::new(0),
        }),
    };
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|err| format!("nao escutei {listen}: {err}"))?;
    let bound = listener
        .local_addr()
        .map_err(|err| format!("endereco local: {err}"))?;
    eprintln!("[gateway] escutando {bound} upstream {upstream} health_nativo={native}");
    axum::serve(listener, router(state))
        .await
        .map_err(|err| format!("servidor encerrou: {err}"))
}

async fn dispatch(State(state): State<AppState>, req: Request<Body>) -> Response<Body> {
    if internal::is_user_path(req.uri().path()) {
        state
            .internal
            .last_user_ms
            .store(internal::now_ms(), Ordering::Relaxed);
    }
    if state.native_health && is_native_health(&req) {
        return health_response(req.method());
    }
    let Some(upstream) = state.upstream.clone() else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            [(CONTENT_TYPE, "application/json; charset=utf-8")],
            r#"{"error":"rota ainda nao portada para Rust"}"#,
        )
            .into_response();
    };
    match forward(&state, &upstream, req).await {
        Ok(response) => response,
        Err(()) => (
            StatusCode::BAD_GATEWAY,
            [(CONTENT_TYPE, "text/plain; charset=utf-8")],
            "bad_gateway",
        )
            .into_response(),
    }
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
    upstream: &Uri,
    req: Request<Body>,
) -> Result<Response<Body>, ()> {
    let (parts, body) = req.into_parts();
    let path = parts
        .uri
        .path_and_query()
        .map(|item| item.as_str())
        .unwrap_or("/");
    let uri = upstream_uri(upstream, path)?;
    let headers = forward_headers(&parts.headers);
    let mut upstream_req = Request::builder()
        .method(parts.method)
        .uri(uri)
        .body(body)
        .map_err(|_| ())?;
    *upstream_req.headers_mut() = headers;
    let response = state.client.request(upstream_req).await.map_err(|_| ())?;
    let (parts, incoming) = response.into_parts();
    let headers = forward_headers(&parts.headers);
    let mut out = Response::new(Body::from_stream(incoming.into_data_stream()));
    *out.status_mut() = parts.status;
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

fn forward_headers(headers: &HeaderMap) -> HeaderMap {
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
