//! Ponte do `/resolve` nativo com o Node (`/internal/resolve/*`).
//!
//! O play é do gateway, mas o que ele PROVA grava estado que mora no Node:
//! `magnetdb` (alive/bad/lie), proteção durável, ledger do RD, `davail`, prova
//! de arquivo e o L1 das listas. A decisão sai pronta do núcleo
//! (`adom_debrid::resolve_effects`); a rota interna só a aplica, com os mesmos
//! helpers da ponte de play do Node (`rust-resolve-apply.ts`).
//!
//! Dois sentidos, ambos fail-safe:
//! - `held` (só AllDebrid): o hold do autofetch. Sem resposta = `true`, ou
//!   seja, o play NÃO apaga o magnet frio de ninguém.
//! - `apply`: os efeitos. Falha vira log; o status do play não muda. No erro o
//!   gateway ESPERA a rota (que só responde depois do flush do store nativo),
//!   para a reabertura imediata já não servir o hash que acabou de falhar.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use adom_debrid::alldebrid::PlayFile;
use adom_debrid::holds_feed::DEFAULT_BASE;
use adom_debrid::play::PlayOutcome;
use adom_debrid::{Call, HttpClient};
use serde_json::{json, Value};

/// Prazo de cada POST interno (ms). O play já gastou o debrid; isto só grava.
pub const TIMEOUT_ENV: &str = "RESOLVE_EFFECTS_TIMEOUT_MS";
const DEFAULT_TIMEOUT_MS: u64 = 2_000;
const FACTS_PATH: &str = "/internal/resolve/facts";
const EFFECTS_PATH: &str = "/internal/resolve/effects";
/// Prazo de ociosidade do pool da ponte. O http server do Node fecha a conexão
/// ociosa em 5 s (default) e o pool do reqwest guardaria 90 s: um play depois de
/// uma pausa cairia numa conexão morta. Abrir outra em loopback é mais barato.
const POOL_IDLE: Duration = Duration::from_secs(2);

pub type BridgeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Ponte trocável: o teste da rota injeta uma que grava os corpos.
pub trait PlayBridge: Send + Sync {
    /// Hold do autofetch na AllDebrid. Qualquer falha devolve `true`.
    fn held<'a>(&'a self, encoded: &'a str, hash: &'a str) -> BridgeFuture<'a, bool>;
    /// Efeitos do play. Erro só vira log.
    fn apply(&self, payload: Value) -> BridgeFuture<'_, ()>;
}

/// Sem Node alcançável (sem token): nada apaga e nada é gravado.
pub struct NoBridge;

impl PlayBridge for NoBridge {
    fn held<'a>(&'a self, _encoded: &'a str, _hash: &'a str) -> BridgeFuture<'a, bool> {
        Box::pin(async { true })
    }
    fn apply(&self, _payload: Value) -> BridgeFuture<'_, ()> {
        Box::pin(async {})
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
            eprintln!("[resolve] sem ponte com o Node (token ou base loopback ausente): o play nativo não grava efeitos e nunca apaga o frio");
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

    fn apply(&self, payload: Value) -> BridgeFuture<'_, ()> {
        Box::pin(async move {
            if let Err(err) = self.post(EFFECTS_PATH, payload).await {
                eprintln!("[resolve] efeitos do play não gravados: {err}");
            }
        })
    }
}

/// De onde o efeito vem: a conta (`encoded`, a chave nunca vai no JSON) e a
/// obra/locação da dica.
pub struct EffectTarget<'a> {
    pub encoded: &'a str,
    pub service: &'a str,
    pub hash: &'a str,
    pub imdb: &'a str,
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

impl EffectTarget<'_> {
    fn base(&self) -> serde_json::Map<String, Value> {
        let mut map = serde_json::Map::new();
        map.insert("encoded".into(), json!(self.encoded));
        map.insert("service".into(), json!(self.service));
        map.insert("hash".into(), json!(self.hash));
        map.insert("imdbId".into(), json!(self.imdb));
        map.insert("season".into(), json!(self.season));
        map.insert("episode".into(), json!(self.episode));
        map
    }
}

/// Play que respondeu: `alive` só com link (o Node só marca vivo no 302).
pub fn ok_payload(target: &EffectTarget, outcome: &PlayOutcome) -> Value {
    let mut map = target.base();
    map.insert("outcome".into(), json!("ok"));
    map.insert("alive".into(), json!(outcome.url.is_some()));
    map.insert("unavailable".into(), json!(outcome.unavailable));
    if let Some(files) = &outcome.files {
        map.insert("files".into(), files_json(files));
    }
    Value::Object(map)
}

/// Play recusado: o efeito plano do núcleo e, quando o adaptador leu, a lista.
/// `None` quando não há nada a gravar (429/502 sem prova): poupa a ida ao Node.
pub fn error_payload(
    target: &EffectTarget,
    effect: &Value,
    files: Option<&[PlayFile]>,
) -> Option<Value> {
    let neutral = effect.get("mark").is_none_or(Value::is_null)
        && effect.get("invalidate").and_then(Value::as_str) == Some("none")
        && effect.get("index").is_none_or(Value::is_null)
        && effect.get("noteBlocked").and_then(Value::as_bool) != Some(true);
    if neutral && files.is_none() {
        return None;
    }
    let mut map = target.base();
    map.insert("outcome".into(), json!("error"));
    map.insert("effect".into(), effect.clone());
    if let Some(files) = files {
        map.insert("files".into(), files_json(files));
    }
    Some(Value::Object(map))
}

fn files_json(files: &[PlayFile]) -> Value {
    Value::Array(
        files
            .iter()
            .map(|file| json!({ "path": file.path, "size": file.size }))
            .collect(),
    )
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
