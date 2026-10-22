//! Devolução das marcas da limpeza NATIVA da AllDebrid ao Node
//! (`POST /internal/debrid/marked`).
//!
//! A checagem da AllDebrid é um `/magnet/upload` real e, com
//! `DEBRID_AL_CLEANUP=on` + `holds_complete` + inventário, a limpeza apaga pela
//! fila com backoff (`alldebrid_delete`). Quem sabe o que SUBIU e o que SAIU de
//! verdade é este lado; quem é dono do `cache.db` é o Node — a posse (`adsub:v1`)
//! e o anti-reenchimento (`adrm:v1`) só podem ser gravados lá. Sem esta ponte o
//! caminho nativo apaga e a busca seguinte re-sobe o mesmo hash: a limpeza vira
//! esteira e o snapshot seguinte classifica o magnet como "do usuário" (imune).
//!
//! A ponte é a rota interna, espelho de [`crate::holds_feed`]:
//!
//! - `submitted` → `adsub`: só o hash que o snapshot do lote (`knownBefore`)
//!   provou AUSENTE antes do upload (a prova de criação do 8.15, feita aqui);
//! - `removed` → `forgetSubmitted` + `adrm`: só o que o `DeleteReport`
//!   CONFIRMOU removido; o nome alimenta a blindagem BR do Node (8.4).
//!
//! Por que rota e não escrita direta: o `cache.db` tem dono único (o Node) e o
//! Rust não conhece o TTL/kill-switch/memo do caminho TS. Corpo pequeno, prazo
//! curto e FAIL-OPEN de ponta a ponta: a marca é efeito colateral, nunca segura
//! a resposta do `/stream`; falha só loga.
//!
//! Gate: `DEBRID_AL_CLEANUP=on` — sem a limpeza ligada não existe caminho que
//! suba ou remova de propósito, então nada é enviado (rollback de uma linha).

use std::time::Duration;

use serde_json::{json, Value};

use crate::alldebrid_cleanup::CleanupMode;
use crate::http::{Call, HttpClient};

/// Caminho da rota no Node.
pub const PATH: &str = "/internal/debrid/marked";
/// Prazo do POST interno (ms). Default 1500 — o Node só faz `cache.set`.
pub const TIMEOUT_ENV: &str = "DEBRID_INTERNAL_MARKED_TIMEOUT_MS";
/// Mesma base do feed de holds: a 7100 é o Node com `GATEWAY=on`.
pub const DEFAULT_BASE: &str = "http://127.0.0.1:7100";

const DEFAULT_TIMEOUT_MS: u64 = 1_500;

/// Um hash que a limpeza removeu de propósito. `name` é o nome da release no
/// `/magnet/upload`; é por ele que o Node reconhece (e NUNCA marca) origem BR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovedMark {
    pub hash: String,
    pub name: Option<String>,
}

/// Lote de marcas de UMA conta. `api_key` viaja no corpo porque é a única
/// identidade disponível nos dois pontos de gatilho (o `encoded` do usuário
/// mora no `adom-search`); a rota é loopback + token e a chave nunca é logada.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarkedBatch {
    pub api_key: String,
    pub submitted: Vec<String>,
    pub removed: Vec<RemovedMark>,
}

impl MarkedBatch {
    pub fn is_empty(&self) -> bool {
        self.submitted.is_empty() && self.removed.is_empty()
    }

    /// Corpo do POST, no contrato da rota.
    pub fn body(&self) -> Value {
        let removed: Vec<Value> = self
            .removed
            .iter()
            .map(|mark| match &mark.name {
                Some(name) => json!({ "hash": mark.hash, "name": name }),
                None => json!({ "hash": mark.hash }),
            })
            .collect();
        json!({
            "service": "alldebrid",
            "apiKey": self.api_key,
            "submitted": self.submitted,
            "removed": removed,
        })
    }
}

/// Cliente da rota interna de marcas (loopback + token).
#[derive(Clone)]
pub struct InternalMarkedClient {
    http: HttpClient,
    base: String,
    token: String,
    timeout: Duration,
}

impl InternalMarkedClient {
    pub fn new(base: &str, token: &str, timeout: Duration) -> Result<Self, String> {
        let base = base.trim_end_matches('/').to_string();
        // Mesma régua do feed: a marca só existe em loopback.
        crate::holds_feed::ensure_loopback(&base)?;
        Ok(Self {
            http: HttpClient::new().map_err(|err| err.message().to_string())?,
            base,
            token: token.to_string(),
            timeout,
        })
    }

    /// Do ambiente: as MESMAS envs internas do feed de holds
    /// (`DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`; base
    /// `INTERNAL_CHECK_URL`, default loopback:7100). Sem token não há canal.
    pub fn from_env() -> Option<Self> {
        let token = std::env::var("DEBRID_INTERNAL_TOKEN")
            .ok()
            .filter(|raw| !raw.trim().is_empty())
            .or_else(|| {
                std::env::var("JACKETT_TEST_TOKEN")
                    .ok()
                    .filter(|raw| !raw.trim().is_empty())
            })?;
        let base = std::env::var("INTERNAL_CHECK_URL")
            .ok()
            .filter(|raw| !raw.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BASE.to_string());
        let timeout = timeout_from(std::env::var(TIMEOUT_ENV).ok().as_deref());
        Self::new(&base, &token, timeout).ok()
    }

    /// POST do lote. Token só no header. O Node responde 202 com contagens; o
    /// corpo não é interpretado — o que importa é ter sido aceito.
    pub async fn send(&self, batch: &MarkedBatch) -> Result<(), String> {
        if self.token.is_empty() {
            return Err("sem token interno".into());
        }
        if batch.api_key.trim().is_empty() {
            return Err("chave da conta ausente".into());
        }
        if batch.is_empty() {
            return Err("lote de marcas vazio".into());
        }
        self.http
            .json(Call {
                method: reqwest::Method::POST,
                url: format!("{}{}", self.base, PATH),
                headers: vec![
                    ("content-type".to_string(), "application/json".to_string()),
                    ("x-indexer-test-token".to_string(), self.token.clone()),
                ],
                body: Some(batch.body().to_string().into_bytes()),
                timeout: self.timeout,
                abort_safe: false,
            })
            .await
            .map_err(|err| err.message().to_string())?;
        Ok(())
    }
}

/// Default do prazo: 1500 ms; mínimo 1 ms.
pub fn timeout_from(raw: Option<&str>) -> Duration {
    let ms = raw
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    Duration::from_millis(ms)
}

/// Dispara a marca em fundo. Fail-open de ponta a ponta: sem a limpeza ligada,
/// sem runtime, sem token ou com a rota fora do ar, só loga — a busca nunca
/// paga por isso e o `cache.db` do Node não é tocado.
pub fn spawn(batch: MarkedBatch) {
    if batch.is_empty() || !CleanupMode::from_env().is_on() {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        eprintln!("[alldebrid] marca nativa sem runtime; lote descartado");
        return;
    };
    handle.spawn(async move {
        let Some(client) = InternalMarkedClient::from_env() else {
            // Sem token/base não há canal: nada a fazer e nada a inventar.
            return;
        };
        if let Err(err) = client.send(&batch).await {
            eprintln!(
                "[alldebrid] marca nativa não entregue ({} subiu, {} removido(s)): {err}",
                batch.submitted.len(),
                batch.removed.len()
            );
        }
    });
}

#[cfg(test)]
#[path = "marks_feed_tests.rs"]
mod marks_feed_tests;

/// Dublê da rota do Node compartilhado pelos testes de checagem e de limpeza:
/// guarda token/corpos e responde 202, como a rota real.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use axum::body::Body;
    use axum::extract::State;
    use axum::http::{Request, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use axum::Router;
    use serde_json::Value;
    use tokio::net::TcpListener;

    /// O que o dublê viu: token do header e corpos aceitos.
    #[derive(Default)]
    pub struct MarksSeen {
        pub tokens: Mutex<Vec<Option<String>>>,
        pub bodies: Mutex<Vec<Value>>,
    }

    async fn route(State(seen): State<Arc<MarksSeen>>, req: Request<Body>) -> Response {
        seen.tokens.lock().unwrap().push(
            req.headers()
                .get("x-indexer-test-token")
                .and_then(|value| value.to_str().ok().map(str::to_string)),
        );
        let body = axum::body::to_bytes(req.into_body(), 1 << 20)
            .await
            .unwrap_or_default();
        if let Ok(value) = serde_json::from_slice::<Value>(&body) {
            seen.bodies.lock().unwrap().push(value);
        }
        (StatusCode::ACCEPTED, "{}").into_response()
    }

    /// Sobe o dublê em loopback e devolve a base (`http://127.0.0.1:<porta>`).
    pub async fn listen(seen: Arc<MarksSeen>) -> String {
        let app = Router::new()
            .route(super::PATH, post(route))
            .with_state(seen);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{addr}")
    }

    /// Espera até `min` corpos (teto de ~2 s) e devolve o que chegou.
    pub async fn wait_bodies(seen: &MarksSeen, min: usize) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let bodies = seen.bodies.lock().unwrap().clone();
            if bodies.len() >= min || Instant::now() >= deadline {
                return bodies;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Espera até um corpo satisfazer `check` (teto de ~2 s). Os testes filtram
    /// por hash: outras suítes rodam em paralelo com as mesmas envs internas.
    pub async fn wait_until<F>(seen: &MarksSeen, check: F) -> Option<Value>
    where
        F: Fn(&Value) -> bool,
    {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let found = seen
                .bodies
                .lock()
                .unwrap()
                .iter()
                .find(|body| check(body))
                .cloned();
            if found.is_some() || Instant::now() >= deadline {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}
