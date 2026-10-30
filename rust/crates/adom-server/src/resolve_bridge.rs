//! Ponte do `/resolve` nativo com o Node (`/internal/resolve/facts`).
//!
//! Só sobrou um sentido: `held` (AllDebrid). O hold do autofetch decide se o
//! play pode apagar o magnet frio, e o estado dele mora no Node. Sem resposta
//! = `true`, ou seja, o play NÃO apaga o frio de ninguém.
//!
//! Os EFEITOS do play (magnet, davail, prova, índice, ledger e listas) não
//! passam mais por aqui: são gravados no próprio gateway por
//! `play_effects_native`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use adom_debrid::holds_feed::DEFAULT_BASE;
use adom_debrid::{Call, HttpClient};
use serde_json::{json, Value};

/// Prazo do POST interno (ms). O play já gastou o debrid; isto só consulta o hold.
pub const TIMEOUT_ENV: &str = "RESOLVE_EFFECTS_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS: u64 = 2_000;
const FACTS_PATH: &str = "/internal/resolve/facts";
/// Prazo de ociosidade do pool da ponte. O http server do Node fecha a conexão
/// ociosa em 5 s (default) e o pool do reqwest guardaria 90 s: um play depois de
/// uma pausa cairia numa conexão morta. Abrir outra em loopback é mais barato.
const POOL_IDLE: Duration = Duration::from_secs(2);

pub type BridgeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Ponte trocável: o teste da rota injeta uma que responde um `held` fixo.
pub trait PlayBridge: Send + Sync {
    /// Hold do autofetch na AllDebrid. Qualquer falha devolve `true`.
    fn held<'a>(&'a self, encoded: &'a str, hash: &'a str) -> BridgeFuture<'a, bool>;
}

/// Sem Node alcançável (sem token): nada apaga o frio.
pub struct NoBridge;

impl PlayBridge for NoBridge {
    fn held<'a>(&'a self, _encoded: &'a str, _hash: &'a str) -> BridgeFuture<'a, bool> {
        Box::pin(async { true })
    }
}

/// Cliente das rotas internas (loopback + `X-Indexer-Test-Token`).
pub struct NodeBridge {
    http: HttpClient,
    base: String,
    token: String,
    timeout: Duration,
}

/// Do ambiente; sem token ou com base fora do loopback, [`NoBridge`] (e log).
pub fn from_env() -> Arc<dyn PlayBridge> {
    let token = ["DEBRID_INTERNAL_TOKEN", "JACKETT_TEST_TOKEN"]
        .iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .filter(|raw| !raw.trim().is_empty())
        });
    let base = std::env::var("INTERNAL_CHECK_URL")
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_BASE.to_string());
    let timeout = Duration::from_millis(
        std::env::var(TIMEOUT_ENV)
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|ms| *ms > 0)
            .unwrap_or(DEFAULT_TIMEOUT_MS),
    );
    match (token, HttpClient::with_pool_idle(Some(POOL_IDLE))) {
        (Some(token), Ok(http)) if is_loopback_base(&base) => Arc::new(NodeBridge {
            http,
            base: base.trim_end_matches('/').to_string(),
            token,
            timeout,
        }),
        _ => {
            eprintln!("[resolve] sem ponte com o Node (token ou base loopback ausente): o play nativo nunca apaga o frio");
            Arc::new(NoBridge)
        }
    }
}

impl NodeBridge {
    async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        let data = self
            .http
            .json(Call {
                method: http::Method::POST,
                url: format!("{}{path}", self.base),
                headers: vec![
                    ("content-type".to_string(), "application/json".to_string()),
                    ("x-indexer-test-token".to_string(), self.token.clone()),
                ],
                body: Some(body.to_string().into_bytes()),
                timeout: self.timeout,
                abort_safe: false,
            })
            .await
            .map_err(|err| err.message().to_string())?
            .ok_or_else(|| "resposta vazia".to_string())?;
        if data.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(data)
        } else {
            Err(data
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("ok:false")
                .to_string())
        }
    }
}

impl PlayBridge for NodeBridge {
    fn held<'a>(&'a self, encoded: &'a str, hash: &'a str) -> BridgeFuture<'a, bool> {
        Box::pin(async move {
            let body = json!({ "encoded": encoded, "service": "alldebrid", "hash": hash });
            match self.post(FACTS_PATH, body).await {
                Ok(data) => data.get("held").and_then(Value::as_bool).unwrap_or(true),
                Err(err) => {
                    eprintln!(
                        "[resolve] fatos do play indisponíveis ({err}); o frio fica na conta"
                    );
                    true
                }
            }
        })
    }
}

/// Só 127.0.0.1/localhost/[::1]: o token interno nunca sai da máquina.
fn is_loopback_base(base: &str) -> bool {
    let rest = base.strip_prefix("http://").unwrap_or("");
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else {
        authority.split(':').next().unwrap_or("")
    };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

#[cfg(test)]
#[path = "resolve_bridge_tests.rs"]
mod tests;
