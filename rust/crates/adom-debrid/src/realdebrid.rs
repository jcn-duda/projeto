//! Fundação HTTP do Real-Debrid.
//!
//! O `/torrents/instantAvailability` foi aposentado: `check_cached` não abre
//! a conta. Medir o raio suja; limpar é o preço, e esta camada não sonda.
//! Fora: oracle, warmer, gate AIMD, enqueue, inventário, `torrentStatus` e
//! `probeInstant`. Sem log de chave, magnet ou corpo.

use std::time::Duration;

use reqwest::Method;
use serde_json::Value;

use crate::error::DebridError;
use crate::http::{Call, HttpClient};

const DEFAULT_BASE: &str = "https://api.real-debrid.com/rest/1.0";
const TIMEOUT: Duration = Duration::from_millis(6_000);
const LIST_LIMIT: u32 = 2500;
const LIST_MAX_ROWS: u32 = 10_000;

/// O serviço não publica disponibilidade em lote.
pub const CACHE_CHECK: bool = false;
const _: () = assert!(!CACHE_CHECK);

pub(super) const READY: &str = "downloaded";
pub(super) const WAITING: &str = "waiting_files_selection";
pub(super) const WORKING: [&str; 5] = [
    "magnet_conversion",
    "queued",
    "downloading",
    "compressing",
    "uploading",
];

/// Peek do ledger, sem banco: hit entra, desconhecido derruba `complete`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachePeek {
    pub cached: Vec<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountStatus {
    pub magnets: usize,
    pub ready: usize,
    pub active: usize,
    pub error: usize,
    pub premium_until: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ActiveCount {
    pub nb: f64,
    pub limit: f64,
}

pub struct RealDebrid {
    client: HttpClient,
    base: String,
    timeout: Duration,
}

impl RealDebrid {
    /// Base recusada fica vazia: a chamada erra sem pedir nada à rede.
    pub fn new(client: HttpClient) -> Self {
        let base = match std::env::var("REALDEBRID_API_BASE") {
            Ok(raw) if !raw.trim().is_empty() => accepted_base(&raw).unwrap_or_default(),
            _ => DEFAULT_BASE.to_string(),
        };
        Self {
            client,
            base,
            timeout: TIMEOUT,
        }
    }

    /// Não faz HTTP. `known` é o peek (`Some(true)` hit, `Some(false)` miss,
    /// `None` desconhecido). Miss não entra e não derruba `complete`.
    pub fn check_cached<S: AsRef<str>>(
        &self,
        hashes: &[S],
        known: impl Fn(&str) -> Option<bool>,
    ) -> CachePeek {
        let _ = self;
        let mut cached = Vec::new();
        let mut complete = true;
        for raw in hashes {
            let hash = raw.as_ref().to_ascii_lowercase();
            match known(&hash) {
                Some(true) => {
                    if !cached.iter().any(|item| item == &hash) {
                        cached.push(hash);
                    }
                }
                Some(false) => {}
                None => complete = false,
            }
        }
        CachePeek { cached, complete }
    }

    /// `GET /user` e a listagem paginada. `downloaded` é ready; erro terminal
    /// é `magnet_error|error|virus|dead`; o resto conta como ativo.
    pub async fn account_status(&self, api_key: &str) -> Result<AccountStatus, DebridError> {
        let user = self.call(api_key, Method::GET, "/user", None).await?;
        let rows = self.list_torrents(api_key).await?;
        let (ready, active, error) = tally(&rows);
        Ok(AccountStatus {
            magnets: rows.len(),
            ready,
            active,
            error,
            premium_until: premium_of(user.as_ref()),
        })
    }

    /// `GET /torrents/activeCount`. Rede ou número ausente vira `Ok(None)`.
    pub async fn active_count(&self, api_key: &str) -> Result<Option<ActiveCount>, DebridError> {
        let data = match self
            .call(api_key, Method::GET, "/torrents/activeCount", None)
            .await
        {
            Ok(data) => data,
            Err(_) => return Ok(None),
        };
        let Some(data) = data else {
            return Ok(None);
        };
        let (Some(nb), Some(limit)) = (js_number(data.get("nb")), js_number(data.get("limit")))
        else {
            return Ok(None);
        };
        Ok(Some(ActiveCount { nb, limit }))
    }

    pub(super) async fn list_torrents(&self, api_key: &str) -> Result<Vec<Value>, DebridError> {
        let mut rows = Vec::new();
        let mut offset = 0u32;
        while offset < LIST_MAX_ROWS {
            let path = format!("/torrents?limit={LIST_LIMIT}&offset={offset}");
            let page = self.call(api_key, Method::GET, &path, None).await?;
            let chunk = match page {
                Some(Value::Array(items)) => items,
                _ => Vec::new(),
            };
            let short = (chunk.len() as u32) < LIST_LIMIT;
            rows.extend(chunk);
            if short {
                break;
            }
            offset = offset.saturating_add(LIST_LIMIT);
        }
        Ok(rows)
    }

    pub(super) async fn call(
        &self,
        api_key: &str,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Option<Value>, DebridError> {
        let url = format!("{}{path}", self.usable_base()?);
        let mut headers = vec![("Authorization".to_string(), format!("Bearer {api_key}"))];
        if body.is_some() {
            headers.push((
                "Content-Type".to_string(),
                "application/x-www-form-urlencoded".to_string(),
            ));
        }
        self.client
            .json(Call {
                method,
                url,
                headers,
                body,
                timeout: self.timeout,
                abort_safe: false,
            })
            .await
    }

    fn usable_base(&self) -> Result<&str, DebridError> {
        if self.base.is_empty() {
            Err(base_rejected())
        } else {
            Ok(&self.base)
        }
    }
}

fn tally(rows: &[Value]) -> (usize, usize, usize) {
    let mut ready = 0usize;
    let mut active = 0usize;
    let mut error = 0usize;
    for row in rows {
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if status == READY {
            ready += 1;
        } else if matches!(status.as_str(), "magnet_error" | "error" | "virus" | "dead") {
            error += 1;
        } else {
            active += 1;
        }
    }
    (ready, active, error)
}

fn premium_of(user: Option<&Value>) -> Option<i64> {
    let text = user?.get("expiration")?.as_str()?.trim();
    if text.is_empty() {
        None
    } else {
        play::parse_iso_ms(text)
    }
}

pub(super) fn js_number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    let n = match value {
        Value::Null => 0.0,
        Value::Bool(flag) => {
            if *flag {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                0.0
            } else {
                text.parse().ok()?
            }
        }
        _ => return None,
    };
    n.is_finite().then_some(n)
}

pub(super) fn id_text(value: &Value) -> Option<String> {
    match value.get("id")? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => number.as_i64().map(|n| n.to_string()),
        _ => None,
    }
}

/// `if (!id)` do JS: string vazia e 0 não são id de torrent.
pub(super) fn truthy_id(value: &Value) -> Option<String> {
    let text = id_text(value)?;
    (text != "0").then_some(text)
}

pub(super) fn find_ready(rows: &[Value], hash: &str) -> Option<String> {
    let hash = hash.to_ascii_lowercase();
    rows.iter().find_map(|row| {
        let got = row.get("hash")?.as_str()?.to_ascii_lowercase();
        let status = row.get("status")?.as_str()?;
        if got == hash && status == READY {
            truthy_id(row)
        } else {
            None
        }
    })
}

/// `URLSearchParams`: espaço vira `+`, o resto percent-encoding em hex maiúsculo.
pub(super) fn form_encode(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    out
}

fn accepted_base(raw: &str) -> Result<String, DebridError> {
    let trimmed = raw.trim().trim_end_matches('/');
    let bad = trimmed.is_empty()
        || trimmed
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '@' | '\\' | '#' | '?'));
    let Some((scheme_raw, rest)) = (!bad).then(|| trimmed.split_once("://")).flatten() else {
        return Err(base_rejected());
    };
    let scheme = scheme_raw.to_ascii_lowercase();
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port_ok) = match authority.split_once(':') {
        Some((host, port)) => (
            host,
            !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()),
        ),
        None => (authority, true),
    };
    let allowed = !rest.is_empty()
        && !host.is_empty()
        && port_ok
        && match scheme.as_str() {
            "https" => true,
            "http" => host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost"),
            _ => false,
        };
    if !allowed {
        return Err(base_rejected());
    }
    Ok(format!("{scheme}://{rest}"))
}

fn base_rejected() -> DebridError {
    DebridError::other("REALDEBRID_API_BASE só aceita https ou http em 127.0.0.1/localhost")
}

#[path = "realdebrid_play.rs"]
mod play;

#[cfg(test)]
#[path = "realdebrid_tests.rs"]
mod realdebrid_tests;

#[cfg(test)]
#[path = "realdebrid_account_tests.rs"]
mod realdebrid_account_tests;
