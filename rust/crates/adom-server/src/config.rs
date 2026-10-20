//! Leitura das envs do gateway. O default deixa o processo na 7000 apontando
//! para o Node na 7100; quem decide subir este binário é o entrypoint.
//!
//! Desde o F4.4 o `/stream` é NATIVO por default (`ROUTES_RUST` ausente =
//! `stream`): o pipeline TS do Node saiu e a rota dele responde 410/503. Para
//! rollback de diagnóstico, `ROUTES_RUST=` (vazio) volta ao proxy puro — mas o
//! rollback FUNCIONAL do corte é imagem/commit anterior com `GATEWAY=off`.

use std::net::SocketAddr;

use http::Uri;

/// Default de `ROUTES_RUST` quando a env está ausente: o corte nativo.
pub const DEFAULT_ROUTES_RUST: &str = "stream";

/// Tokens de `ROUTES_RUST` (CSV). `health` liga o nativo; `stream-shadow` arma
/// a observação em paralelo (HISTÓRICO: a referência Node do `/stream` está
/// aposentada — ver `docs/rust-stream-contract.md`); `stream` (token exato)
/// corta `/stream` no Rust (prioridade sobre a sombra); `resolve` arma a guarda
/// HMAC do play.
#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub upstream: Uri,
    pub native_health: bool,
    /// `ROUTES_RUST` contém `stream-shadow`: Node responde; Rust observa.
    pub stream_shadow: bool,
    /// `ROUTES_RUST` contém `stream`: corte nativo via `adom-search`.
    pub stream_native: bool,
    /// `ROUTES_RUST` contém `resolve`: verifica HMAC e (strangler) proxy.
    pub resolve_native: bool,
    /// Encaminha o play ao Node após o verify. `false` → 501 (sem debrid).
    pub resolve_proxy: bool,
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
        let resolve_proxy = resolve_proxy_from_env();
        let resolve_secret = std::env::var("RESOLVE_SECRET").unwrap_or_default();
        Self::parse(&listen, &upstream, &routes, resolve_proxy, resolve_secret)
    }

    pub fn parse(
        listen: &str,
        upstream: &str,
        routes: &str,
        resolve_proxy: bool,
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
            stream_shadow: stream_shadow(routes),
            stream_native: stream_native(routes),
            resolve_native: resolve_native(routes),
            resolve_proxy,
            resolve_secret,
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

/// Token exato `resolve`.
pub fn resolve_native(routes: &str) -> bool {
    has_route_token(routes, "resolve")
}

/// `GATEWAY_RESOLVE_PROXY`: default ligado; `off`/`false`/`0` desliga.
pub fn resolve_proxy_from_env() -> bool {
    match std::env::var("GATEWAY_RESOLVE_PROXY") {
        Ok(raw) => {
            let v = raw.trim().to_ascii_lowercase();
            !matches!(v.as_str(), "0" | "false" | "off" | "no")
        }
        Err(_) => true,
    }
}

fn has_route_token(routes: &str, token: &str) -> bool {
    routes.split(',').any(|part| part.trim() == token)
}
