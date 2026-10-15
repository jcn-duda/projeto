//! Leitura das envs do servidor. Sem `GATEWAY_UPSTREAM` não há Node atrás: as
//! rotas portadas respondem daqui e as outras dizem que ainda não existem.

use std::net::SocketAddr;

use http::Uri;

/// `health` na lista liga só `GET`/`HEAD /health`. O resto continua proxy.
#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    /// Node atrás do gateway; `None` (env vazia ou `off`) = só Rust.
    pub upstream: Option<Uri>,
    pub native_health: bool,
    /// Token das rotas internas e de diagnóstico (`X-Indexer-Test-Token`).
    pub token: String,
    /// Banco do acervo que o raspador alimenta.
    pub acervo_path: String,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let env = |key: &str| std::env::var(key).unwrap_or_default();
        let listen = std::env::var("GATEWAY_LISTEN").unwrap_or_else(|_| "0.0.0.0:7000".to_string());
        let routes = env("ROUTES_RUST");
        let mut config = Self::parse(&listen, &env("GATEWAY_UPSTREAM"), &routes)?;
        // JACKETT_TEST_TOKEN é o principal; ADMIN_TOKEN é alias (mesma régua do sidecar).
        config.token = Some(env("JACKETT_TEST_TOKEN"))
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| env("ADMIN_TOKEN"))
            .trim()
            .to_string();
        config.acervo_path =
            std::env::var("ACERVO_DB_PATH").unwrap_or_else(|_| "./data/acervo.db".to_string());
        Ok(config)
    }

    pub fn parse(listen: &str, upstream: &str, routes: &str) -> Result<Self, String> {
        let listen: SocketAddr = listen
            .parse()
            .map_err(|_| format!("GATEWAY_LISTEN invalido: {listen}"))?;
        let upstream = match upstream.trim() {
            "" | "off" => None,
            raw => {
                let uri: Uri = raw
                    .parse()
                    .map_err(|_| format!("GATEWAY_UPSTREAM invalido: {raw}"))?;
                if uri.scheme_str() != Some("http") || uri.authority().is_none() {
                    return Err(format!("GATEWAY_UPSTREAM precisa ser http com host: {uri}"));
                }
                Some(uri)
            }
        };
        Ok(Self {
            listen,
            // Sem upstream ninguém mais responde o /health.
            native_health: upstream.is_none() || native_health(routes),
            upstream,
            token: String::new(),
            acervo_path: String::new(),
        })
    }
}

pub fn native_health(routes: &str) -> bool {
    routes.split(',').any(|part| part.trim() == "health")
}
