//! Cliente HTTP das rotas internas de busca do Node
//! (`POST /internal/search/{meta,state,collect,index-write,effects}`).
//!
//! Rede ainda no Node: o orquestrador Rust fala em loopback com token no
//! **header** (`X-Indexer-Test-Token`) e a config do usuário no **corpo**
//! (`encoded`) — invariante: preferência nunca vem do `.env`; o Node restaura
//! via `runtime.run`. Falha de rede/HTTP/parse → `Err` — NUNCA panic; a busca
//! não pode cair.

use std::net::IpAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use adom_debrid::{Call, HttpClient};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;

use crate::internal_types::{
    CollectRequest, CollectResponse, EffectsRequest, EffectsResponse, IndexWriteRequest,
    IndexWriteResponse, MetaRequest, MetaResponse, StateRequest, StateResponse,
};

/// Com `GATEWAY=on` o Node escuta em 7100 (gateway Rust na 7000 pública).
pub const DEFAULT_BASE: &str = "http://127.0.0.1:7100";
/// Teto HTTP de meta/state/index-write/effects. Collect **não** usa este teto:
/// o timeout HTTP é `remaining + COLLECT_GRACE_MS` até o `deadline_at` absoluto
/// (espelha o Node; collect longo pode passar de 15s).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(15_000);
/// Folga de rede depois do prazo absoluto do collect (o Node já cortou).
const COLLECT_GRACE_MS: u64 = 250;

#[derive(Clone)]
pub struct InternalSearchClient {
    http: HttpClient,
    base: String,
    token: String,
    timeout: Duration,
}

impl InternalSearchClient {
    pub fn new(base: &str, token: &str, timeout: Duration) -> Result<Self, String> {
        let base = base.trim_end_matches('/').to_string();
        ensure_loopback(&base)?;
        Ok(Self {
            http: HttpClient::new().map_err(|err| err.message().to_string())?,
            base,
            token: token.to_string(),
            timeout,
        })
    }

    /// `INTERNAL_SEARCH_URL` (default loopback:7100) + `JACKETT_TEST_TOKEN`.
    /// Sem token → `None` (a rota do Node recusaria 503 de qualquer forma).
    pub fn from_env() -> Option<Self> {
        let token = std::env::var("JACKETT_TEST_TOKEN")
            .ok()
            .filter(|raw| !raw.trim().is_empty())?;
        let base = std::env::var("INTERNAL_SEARCH_URL")
            .ok()
            .filter(|raw| !raw.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BASE.to_string());
        Self::new(&base, &token, DEFAULT_TIMEOUT).ok()
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// POST `/internal/search/meta` — Cinemeta+TMDB (+opt-in multiwork/home).
    pub async fn meta(&self, req: &MetaRequest) -> Result<MetaResponse, String> {
        self.post_ok("/internal/search/meta", req, self.timeout)
            .await
    }

    /// POST `/internal/search/state` — acervo em lote (obras/sources/firstSeen).
    pub async fn state(&self, req: &StateRequest) -> Result<StateResponse, String> {
        self.post_ok("/internal/search/state", req, self.timeout)
            .await
    }

    /// POST `/internal/search/collect` — um `taskScope` com prazo ABSOLUTO.
    /// O timeout HTTP é `remaining + COLLECT_GRACE_MS` (sem teto de 15s);
    /// já vencido devolve `Err` sem ir à rede (espelha o 400 do Node).
    pub async fn collect(&self, req: &CollectRequest) -> Result<CollectResponse, String> {
        let timeout = timeout_until(req.deadline_at)?;
        self.post_ok("/internal/search/collect", req, timeout).await
    }

    /// POST `/internal/search/index-write` — grava índice + marca banco.
    pub async fn index_write(&self, req: &IndexWriteRequest) -> Result<IndexWriteResponse, String> {
        self.post_ok("/internal/search/index-write", req, self.timeout)
            .await
    }

    /// POST `/internal/search/effects` — fire-and-forget; espera **202**.
    pub async fn effects(&self, req: &EffectsRequest) -> Result<EffectsResponse, String> {
        self.post_ok("/internal/search/effects", req, self.timeout)
            .await
    }

    async fn post_ok<B: Serialize, R: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
        timeout: Duration,
    ) -> Result<R, String> {
        if self.token.is_empty() {
            return Err("sem token interno".into());
        }
        let payload = serde_json::to_vec(body).map_err(|err| format!("json body: {err}"))?;
        // Invariante: encoded sempre no corpo quando a rota exige.
        let check: Value =
            serde_json::from_slice(&payload).map_err(|err| format!("json body: {err}"))?;
        if check
            .get("encoded")
            .and_then(Value::as_str)
            .map(|s| s.is_empty())
            .unwrap_or(true)
        {
            return Err("encoded ausente".into());
        }
        let data = self
            .http
            .json(Call {
                method: Method::POST,
                url: format!("{}{path}", self.base),
                headers: vec![
                    ("content-type".to_string(), "application/json".to_string()),
                    ("x-indexer-test-token".to_string(), self.token.clone()),
                ],
                body: Some(payload),
                timeout,
                abort_safe: false,
            })
            .await
            .map_err(|err| err.message().to_string())?;
        let Some(data) = data else {
            return Err("resposta vazia da rota interna".into());
        };
        if data.get("ok").and_then(Value::as_bool) == Some(false) {
            let err = data
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("ok:false sem error");
            return Err(err.to_string());
        }
        serde_json::from_value(data).map_err(|err| format!("parse resposta: {err}"))
    }
}

/// Timeout HTTP do collect a partir de `deadline_at` (epoch ms).
/// Sem `min(DEFAULT_TIMEOUT)` — o prazo absoluto manda. Já vencido → Err.
fn timeout_until(deadline_at_ms: i64) -> Result<Duration, String> {
    let remaining = deadline_at_ms.saturating_sub(now_ms());
    if remaining <= 0 {
        return Err("deadline_at já venceu".into());
    }
    let budget = Duration::from_millis((remaining as u64).saturating_add(COLLECT_GRACE_MS));
    Ok(budget.max(Duration::from_millis(1)))
}

/// Só loopback: token + encoded não saem para host externo (espelha
/// `InternalCheckClient` em adom-debrid).
fn ensure_loopback(base: &str) -> Result<(), String> {
    let rest = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("https://"))
        .ok_or_else(|| format!("INTERNAL_SEARCH_URL precisa de http(s): {base}"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else if let Some((h, port)) = authority.rsplit_once(':') {
        if port.chars().all(|c| c.is_ascii_digit()) {
            h
        } else {
            authority
        }
    } else {
        authority
    };
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
    if !loopback {
        return Err(format!("INTERNAL_SEARCH_URL só aceita loopback: {base}"));
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "internal_client_tests.rs"]
mod internal_client_tests;
