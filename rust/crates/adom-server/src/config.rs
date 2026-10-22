//! Leitura das envs do gateway. O default deixa o processo na 7000 apontando
//! para o Node na 7100; o entrypoint sobe este binário sempre (é o caminho de
//! produção, não um modo).
//!
//! O `/stream` é NATIVO por default (`ROUTES_RUST` ausente = `stream`): o
//! pipeline TS do Node saiu e a rota dele responde 410/503. `ROUTES_RUST=`
//! (vazio) e `ROUTES_RUST=health` são DIAGNÓSTICO do proxy; o rollback do
//! corte é imagem/commit anterior.
//!
//! O play `/resolve` nativo por debrid NÃO tem flag (fase C do F4.7): é o
//! caminho único do gateway, e o rollback também é imagem/commit anterior.

use std::net::SocketAddr;

use http::Uri;

/// Default de `ROUTES_RUST` quando a env está ausente: o corte nativo.
pub const DEFAULT_ROUTES_RUST: &str = "stream";

/// Tokens de `ROUTES_RUST` (CSV). `health` liga o nativo; `stream` (token
/// exato) corta `/stream` no Rust.
#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub upstream: Uri,
    pub native_health: bool,
    /// `ROUTES_RUST` contém `stream`: corte nativo via `adom-search`.
    pub stream_native: bool,
    /// `RESOLVE_SECRET` do operador (precedência sobre `dk` da URL).
    pub resolve_secret: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let listen = std::env::var("GATEWAY_LISTEN").unwrap_or_else(|_| "0.0.0.0:7000".to_string());
        let upstream = std::env::var("GATEWAY_UPSTREAM")
            .unwrap_or_else(|_| "http://127.0.0.1:7100".to_string());
        let routes =
            std::env::var("ROUTES_RUST").unwrap_or_else(|_| DEFAULT_ROUTES_RUST.to_string());
        let resolve_secret = std::env::var("RESOLVE_SECRET").unwrap_or_default();
        Self::parse(&listen, &upstream, &routes, resolve_secret)
    }

    pub fn parse(
        listen: &str,
        upstream: &str,
        routes: &str,
        resolve_secret: String,
    ) -> Result<Self, String> {
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
            stream_native: stream_native(routes),
            resolve_secret,
        })
    }
}

pub fn native_health(routes: &str) -> bool {
    has_route_token(routes, "health")
}

/// Token exato `stream`.
pub fn stream_native(routes: &str) -> bool {
    has_route_token(routes, "stream")
}

fn has_route_token(routes: &str, token: &str) -> bool {
    routes.split(',').any(|part| part.trim() == token)
}
