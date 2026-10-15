//! Leitura das envs do gateway. O default deixa o processo na 7000 apontando
//! para o Node na 7100; quem decide subir este binário é o entrypoint.

use std::net::SocketAddr;

use http::Uri;

/// `health` na lista liga só `GET`/`HEAD /health`. O resto continua proxy.
#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub upstream: Uri,
    pub native_health: bool,
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
        })
    }
}

pub fn native_health(routes: &str) -> bool {
    routes.split(',').any(|part| part.trim() == "health")
}
