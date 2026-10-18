//! Cliente de RESERVA para a rota interna do Node `/internal/debrid/check`
//! (loopback + `X-Indexer-Test-Token`). Corpo alinhado à rota Node:
//! `{ encoded, service, hashes, deadline_at }` — a chave do debrid vem do
//! `encoded` (runtime do usuário), nunca no JSON. Token só no header.
//!
//! Resposta: `{ ok, service, results: { [hash]: { cached, known, unusable? } }, … }`.
//! Erro NUNCA vira "não está em cache" (fail-safe: sem resposta há `known:false`).

use std::net::IpAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::http::HttpClient;
use crate::verdict::{CheckOutcome, UnusableKind};

/// Default da porta do addon em loopback (`scripts/entrypoint.sh`).
pub const DEFAULT_BASE: &str = "http://127.0.0.1:7000";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(4_000);

#[derive(Clone)]
pub struct InternalCheckClient {
    http: HttpClient,
    base: String,
    token: String,
    timeout: Duration,
}

impl InternalCheckClient {
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

    /// Do ambiente: `INTERNAL_CHECK_URL` (default loopback:7000) e o token
    /// interno (`DEBRID_INTERNAL_TOKEN`, caindo para `JACKETT_TEST_TOKEN`).
    /// Sem token, não há cliente — a rota do Node recusaria 503.
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
        Self::new(&base, &token, DEFAULT_TIMEOUT).ok()
    }

    /// POST com token no header. Sem `apiKey` no corpo — a chave mora no
    /// `encoded`. O prazo HTTP é o mínimo entre o teto do cliente e o que
    /// sobra até `deadline_at` (epoch ms).
    pub async fn check(
        &self,
        encoded: &str,
        service: &str,
        hashes: &[String],
        deadline_at: i64,
    ) -> Result<CheckOutcome, String> {
        if self.token.is_empty() {
            return Err("sem token interno".into());
        }
        if encoded.trim().is_empty() {
            return Err("encoded ausente".into());
        }
        let remaining = deadline_at.saturating_sub(now_ms());
        if remaining <= 0 {
            return Err("deadline_at já venceu".into());
        }
        let timeout = self.timeout.min(Duration::from_millis(remaining as u64));
        let body = serde_json::json!({
            "encoded": encoded,
            "service": service,
            "hashes": hashes,
            "deadline_at": deadline_at,
        });
        let data = self
            .http
            .json(crate::http::Call {
                method: reqwest::Method::POST,
                url: format!("{}/internal/debrid/check", self.base),
                headers: vec![
                    ("content-type".to_string(), "application/json".to_string()),
                    ("x-indexer-test-token".to_string(), self.token.clone()),
                ],
                body: Some(body.to_string().into_bytes()),
                timeout,
                abort_safe: false,
            })
            .await
            .map_err(|err| err.message().to_string())?;
        let Some(data) = data else {
            return Err("resposta vazia da rota interna".into());
        };
        parse_node_response(&data)
    }
}

/// Só loopback: a rota Node recusa origem externa; o cliente não tenta.
fn ensure_loopback(base: &str) -> Result<(), String> {
    let rest = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("https://"))
        .ok_or_else(|| format!("INTERNAL_CHECK_URL precisa de http(s): {base}"))?;
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
        return Err(format!("INTERNAL_CHECK_URL só aceita loopback: {base}"));
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Corpo da rota Node → [`CheckOutcome`].
///
/// - `ok:false` / sem `results` → erro (não inventa Missing);
/// - `configured:false` → Unknown honesto (P2P, sem chave no encoded);
/// - `unusable` no topo → Unusable (auth/quota);
/// - por hash: `cached:true` entra em `cached`; `known` do lote é true só se
///   TODOS os hashes tiverem `known:true` (timeout/partial → known:false).
pub fn parse_node_response(data: &Value) -> Result<CheckOutcome, String> {
    let ok = data
        .get("ok")
        .and_then(Value::as_bool)
        .ok_or_else(|| "corpo da rota interna sem ok".to_string())?;
    if !ok {
        let msg = data
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("ok:false");
        return Err(msg.to_string());
    }
    if data.get("configured").and_then(Value::as_bool) == Some(false) {
        return Ok(CheckOutcome {
            cached: Vec::new(),
            known: false,
            unusable: None,
        });
    }
    if let Some(reason) = data.get("unusable").and_then(Value::as_str) {
        let kind = match reason {
            "auth" => UnusableKind::Auth,
            "quota" => UnusableKind::Quota,
            other => return Err(format!("unusable desconhecido: {other}")),
        };
        return Ok(CheckOutcome {
            cached: Vec::new(),
            known: false,
            unusable: Some((kind, String::new())),
        });
    }
    let results = data
        .get("results")
        .and_then(Value::as_object)
        .ok_or_else(|| "corpo da rota interna sem results".to_string())?;
    let mut cached = Vec::new();
    let mut known = !results.is_empty();
    let mut unusable = None;
    for (hash, row) in results {
        if row.get("cached").and_then(Value::as_bool) == Some(true) {
            cached.push(hash.to_lowercase());
        }
        if row.get("known").and_then(Value::as_bool) != Some(true) {
            known = false;
        }
        if unusable.is_none() {
            if let Some(reason) = row.get("unusable").and_then(Value::as_str) {
                let kind = match reason {
                    "auth" => Some(UnusableKind::Auth),
                    "quota" => Some(UnusableKind::Quota),
                    _ => None,
                };
                if let Some(kind) = kind {
                    unusable = Some((kind, String::new()));
                }
            }
        }
    }
    // results vazio com configured:true (ex.: sem hashes) → known:false.
    if results.is_empty() {
        known = false;
    }
    Ok(CheckOutcome {
        cached,
        known,
        unusable,
    })
}

/// Alias legado: o parse do sidecar (`cached[]` + `known`) NÃO é o da rota
/// Node. Mantido só para não quebrar callers que ainda apontavam o nome.
#[deprecated(note = "use parse_node_response — contrato da rota Node")]
pub fn parse_verdict(data: &Value) -> Result<CheckOutcome, String> {
    parse_node_response(data)
}

#[cfg(test)]
#[path = "internal_check_tests.rs"]
mod internal_check_tests;
