//! Adaptador Debrid-Link; disponibilidade não consulta rede.

use std::time::Duration;

use reqwest::Method;
use serde_json::Value;

use adom_core::{
    pick_file, DebridFile, EpisodeContext, EpisodeEvidence, PickCode, PickOutcome, PlayHint,
};

use crate::error::DebridError;
use crate::http::{Call, HttpClient};

const DEFAULT_BASE: &str = "https://debrid-link.com/api/v2";
const TIMEOUT: Duration = Duration::from_millis(6_000);
const MAX_POLLS: u32 = 4;

pub const CACHE_CHECK: bool = false;
const _: () = assert!(!CACHE_CHECK);

pub struct DebridLink {
    client: HttpClient,
    base: String,
    timeout: Duration,
}

impl DebridLink {
    pub fn new(client: HttpClient) -> Self {
        Self {
            client,
            base: base_from_env(),
            timeout: TIMEOUT,
        }
    }

    pub async fn check_cached(&self) -> Result<Vec<String>, DebridError> {
        Ok(Vec::new())
    }

    /// `poll_wait` na produção é 700 ms. Os testes passam `Duration::ZERO`.
    pub async fn resolve_link(
        &self,
        api_key: &str,
        hash: &str,
        hint: &PlayHint,
        magnet: Option<&str>,
        poll_wait: Duration,
    ) -> Result<Option<String>, DebridError> {
        self.usable_base()?;
        let magnet = magnet_for(hash, magnet);
        let added = self
            .call(
                api_key,
                "/seedbox/add",
                Method::POST,
                Some(add_body(&magnet)),
                &[],
            )
            .await?;
        let Some(id) = truthy_id(&added) else {
            return Ok(None);
        };
        let mut entry = added;
        for _ in 0..MAX_POLLS {
            if !percent_below_100(&entry) {
                break;
            }
            tokio::time::sleep(poll_wait).await;
            let list = self
                .call(
                    api_key,
                    "/seedbox/list",
                    Method::GET,
                    None,
                    &[("ids", id.as_str())],
                )
                .await?;
            entry = first_row(list);
        }
        if percent_below_100(&entry) {
            return Ok(None);
        }
        link_for_entry(&entry, hint)
    }

    fn usable_base(&self) -> Result<&str, DebridError> {
        if self.base.is_empty() {
            return Err(base_rejected());
        }
        Ok(&self.base)
    }

    /// `pub(super)` para o inventário (`crate::account`) reusar o mesmo
    /// transporte, incluindo a classificação de erro do `value_of`.
    pub(super) async fn call(
        &self,
        api_key: &str,
        path: &str,
        method: Method,
        body: Option<Vec<u8>>,
        params: &[(&str, &str)],
    ) -> Result<Value, DebridError> {
        let base = self.usable_base()?;
        let mut headers = vec![("Authorization".to_string(), format!("Bearer {api_key}"))];
        if body.is_some() {
            let kind = "application/x-www-form-urlencoded".to_string();
            headers.push(("Content-Type".to_string(), kind));
        }
        let data = self
            .client
            .json(Call {
                method,
                url: with_query(&format!("{base}{path}"), params),
                headers,
                body,
                timeout: self.timeout,
                abort_safe: false,
            })
            .await?;
        let Some(data) = data else {
            return Err(DebridError::other("debrid-link retornou erro"));
        };
        value_of(data)
    }
}

#[path = "debridlink_autofetch.rs"]
mod autofetch;
pub use autofetch::DebridLinkStatus;

fn base_from_env() -> String {
    match std::env::var("DEBRIDLINK_API_BASE") {
        Ok(raw) if !raw.trim().is_empty() => accepted_base(&raw).unwrap_or_default(),
        _ => DEFAULT_BASE.to_string(),
    }
}

/// `https` em qualquer host, ou `http` só em 127.0.0.1/localhost. Sem barra final.
fn accepted_base(raw: &str) -> Result<String, DebridError> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty()
        || trimmed
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '@' | '\\' | '#' | '?'))
    {
        return Err(base_rejected());
    }
    let Some((scheme_raw, rest)) = trimmed.split_once("://") else {
        return Err(base_rejected());
    };
    if rest.is_empty() {
        return Err(base_rejected());
    }
    let scheme = scheme_raw.to_ascii_lowercase();
    let authority = rest.split('/').next().unwrap_or("");
    let Some(host) = host_of(authority) else {
        return Err(base_rejected());
    };
    let allowed = match scheme.as_str() {
        "https" => true,
        "http" => host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost"),
        _ => false,
    };
    if !allowed {
        return Err(base_rejected());
    }
    Ok(format!("{scheme}://{rest}"))
}

fn host_of(authority: &str) -> Option<&str> {
    if authority.is_empty() {
        return None;
    }
    let host = match authority.split_once(':') {
        Some((host, port)) => {
            if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            host
        }
        None => authority,
    };
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

fn base_rejected() -> DebridError {
    DebridError::other("DEBRIDLINK_API_BASE só aceita https ou http em 127.0.0.1/localhost")
}

/// HTTP 200 com `success: false` é `Error` genérico no TS (`throw new Error`),
/// não auth só porque o texto casa a regex. O status HTTP quem classifica é o cliente.
fn value_of(data: Value) -> Result<Value, DebridError> {
    let Some(obj) = data.as_object() else {
        return Err(DebridError::other("debrid-link retornou erro"));
    };
    if obj.get("success").and_then(Value::as_bool) == Some(false) {
        let message = obj
            .get("error")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or("debrid-link retornou erro");
        return Err(DebridError::Other(message.to_string()));
    }
    Ok(obj.get("value").cloned().unwrap_or(Value::Null))
}

fn magnet_for(hash: &str, magnet: Option<&str>) -> String {
    if let Some(uri) = magnet {
        let carries_hash = !hash.is_empty()
            && uri
                .to_ascii_lowercase()
                .contains(&hash.to_ascii_lowercase());
        if uri.starts_with("magnet:?") && carries_hash {
            return uri.to_string();
        }
    }
    adom_core::default_magnet(hash)
}

fn add_body(magnet: &str) -> Vec<u8> {
    let mut body = String::from("url=");
    body.push_str(&form_encode(magnet));
    body.push_str("&async=true");
    body.into_bytes()
}

fn with_query(url: &str, params: &[(&str, &str)]) -> String {
    if params.is_empty() {
        return url.to_string();
    }
    let mut out = String::from(url);
    out.push('?');
    for (index, (key, value)) in params.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        out.push_str(&form_encode(key));
        out.push('=');
        out.push_str(&form_encode(value));
    }
    out
}

/// `application/x-www-form-urlencoded` do `URLSearchParams`: espaço vira `+`.
fn form_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    out
}

fn truthy_id(value: &Value) -> Option<String> {
    match value.get("id")? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => {
            let parsed = number.as_f64()?;
            if parsed == 0.0 || !parsed.is_finite() {
                None
            } else if let Some(int) = number.as_i64() {
                Some(int.to_string())
            } else {
                Some(number.to_string())
            }
        }
        _ => None,
    }
}

/// `Number(undefined)` é NaN, e `NaN < 100` é falso: campo ausente não espera.
fn percent_below_100(entry: &Value) -> bool {
    match js_number(entry.get("downloadPercent")) {
        Some(percent) => percent < 100.0,
        None => false,
    }
}

fn js_number(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    match value {
        Value::Null => Some(0.0),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64().filter(|n| n.is_finite()),
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                Some(0.0)
            } else {
                text.parse::<f64>().ok().filter(|n| n.is_finite())
            }
        }
        _ => None,
    }
}

fn first_row(value: Value) -> Value {
    match value {
        Value::Array(rows) => rows.into_iter().next().unwrap_or(Value::Null),
        other => other,
    }
}

struct RemoteFile {
    path: String,
    size: f64,
    link: Option<String>,
}

fn remote_files(entry: &Value) -> Vec<RemoteFile> {
    let Some(list) = entry.get("files").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter().map(remote_file).collect()
}

fn remote_file(file: &Value) -> RemoteFile {
    let text = |key: &str| file.get(key).and_then(Value::as_str);
    RemoteFile {
        path: text("name").unwrap_or("").to_string(),
        size: js_number(file.get("size")).unwrap_or(0.0),
        link: text("downloadUrl")
            .filter(|link| !link.is_empty())
            .map(str::to_string),
    }
}

fn link_for_entry(entry: &Value, hint: &PlayHint) -> Result<Option<String>, DebridError> {
    let remote = remote_files(entry);
    let files: Vec<DebridFile> = remote
        .iter()
        .map(|file| DebridFile {
            path: file.path.clone(),
            size: file.size,
        })
        .collect();
    match pick_file(&files, hint) {
        PickOutcome::Empty => {
            // O TS audita mesmo sem arquivo escolhido (lista vazia não condena).
            crate::play_audit::assert_dubbed(&files, hint)?;
            Ok(None)
        }
        PickOutcome::File { path, size } => {
            crate::play_audit::assert_dubbed(&files, hint)?;
            Ok(download_link(&remote, &path, size))
        }
        PickOutcome::Error {
            code,
            evidence,
            context,
        } => Err(pick_error(code, evidence, context)),
    }
}

fn download_link(files: &[RemoteFile], path: &str, size: f64) -> Option<String> {
    let mut fallback = None;
    for file in files {
        if file.path != path {
            continue;
        }
        if (file.size - size).abs() < 0.5 {
            return file.link.clone();
        }
        if fallback.is_none() {
            fallback = file.link.clone();
        }
    }
    fallback
}

fn pick_error(
    code: PickCode,
    evidence: Option<EpisodeEvidence>,
    context: Option<EpisodeContext>,
) -> DebridError {
    DebridError::from_pick(code, evidence, context)
}

#[cfg(test)]
#[path = "debridlink_tests.rs"]
mod debridlink_tests;

#[cfg(test)]
#[path = "debridlink_play_tests.rs"]
mod debridlink_play_tests;
