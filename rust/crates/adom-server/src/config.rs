//! Leitura das envs do gateway. O default deixa o processo na 7000 apontando
//! para o Node na 7100; quem decide subir este binário é o entrypoint.

use std::net::SocketAddr;

use http::Uri;

/// Tokens de `ROUTES_RUST` (CSV). `health` liga o nativo; `stream-shadow` arma
/// a observação em paralelo; `stream` (token exato) corta `/stream` no Rust
/// (prioridade sobre a sombra).
#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub upstream: Uri,
    pub native_health: bool,
    /// `ROUTES_RUST` contém `stream-shadow`: Node responde; Rust observa.
    pub stream_shadow: bool,
    /// `ROUTES_RUST` contém `stream`: corte nativo via `adom-search`.
    pub stream_native: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let listen = std::env::var("GATEWAY_LISTEN").unwrap_or_else(|_| "0.0.0.0:7000".to_string());
        let upstream = std::env::var("GATEWAY_UPSTREAM")
            .unwrap_or_else(|_| "http://127.0.0.1:7100".to_string());
        let routes = std::env::var("ROUTES_RUST").unwrap_or_default();
        Self::parse(&listen, &upstream, &routes)
    }

    pub fn parse(listen: &str, upstream: &str, routes: &str) -> Result<Self, String> {
        let listen: SocketAddr = listen
            .parse()
            .map_err(|_| format!("GATEWAY_LISTEN invalido: {listen}"))?;
        let upstream: Uri = upstream
            .parse()
            .map_err(|_| format!("GATEWAY_UPSTREAM invalido: {upstream}"))?;
        if upstream.scheme_str() != Some("http") || upstream.authority().is_none() {
            return Err(format!(
                "GATEWAY_UPSTREAM precisa ser http com host: {upstream}"
            ));
        }
        Ok(Self {
            listen,
            upstream,
            native_health: native_health(routes),
            stream_shadow: stream_shadow(routes),
            stream_native: stream_native(routes),
        })
    }
}

pub fn native_health(routes: &str) -> bool {
    has_route_token(routes, "health")
}

pub fn stream_shadow(routes: &str) -> bool {
    has_route_token(routes, "stream-shadow")
}

/// Token exato `stream` — não confunde com `stream-shadow`.
pub fn stream_native(routes: &str) -> bool {
    has_route_token(routes, "stream")
}

fn has_route_token(routes: &str, token: &str) -> bool {
    routes.split(',').any(|part| part.trim() == token)
}
