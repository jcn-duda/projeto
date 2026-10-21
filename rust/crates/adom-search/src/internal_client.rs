//! Cliente HTTP das rotas internas de busca do Node
//! (`POST /internal/search/{meta,effects}`).
//!
//! Índice/banco e coleta NÃO passam mais por aqui: são nativos. Rede ainda no
//! Node: o orquestrador Rust fala em loopback com token no **header**
//! (`X-Indexer-Test-Token`) e a config do usuário no **corpo** (`encoded`) —
//! invariante: preferência nunca vem do `.env`; o Node restaura via
//! `runtime.run`. Falha de rede/HTTP/parse → `Err` — NUNCA panic; a busca não
//! pode cair.

use std::net::IpAddr;
use std::time::Duration;

use adom_debrid::{Call, HttpClient};
use reqwest::Method;
use serde::Serialize;
use serde_json::Value;

use crate::internal_types::{EffectsRequest, EffectsResponse, MetaRequest, MetaResponse};

/// Com `GATEWAY=on` o Node escuta em 7100 (gateway Rust na 7000 pública).
pub const DEFAULT_BASE: &str = "http://127.0.0.1:7100";
/// Teto HTTP de meta/effects.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(15_000);

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

#[cfg(test)]
#[path = "internal_client_tests.rs"]
mod internal_client_tests;
