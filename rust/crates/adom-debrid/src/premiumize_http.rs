//! Parse e HTTP do Premiumize, separado para caber na catraca.

use std::collections::HashSet;
use std::time::Duration;

use adom_core::{default_magnet, DebridFile, EpisodeContext, EpisodeEvidence, PickCode};
use reqwest::Method;
use serde_json::Value;

use super::{CacheReport, ContentFile};
use crate::error::DebridError;
use crate::http::{Call, HttpClient};

type BatchRows = Vec<(String, Option<u64>)>;

pub(super) fn fold_batches(
    results: Vec<Result<BatchRows, DebridError>>,
) -> Result<CacheReport, DebridError> {
    let total = results.len();
    let mut cached = Vec::new();
    let mut totals = Vec::new();
    let mut failures = 0usize;
    let mut kind_n = [0usize; 3];
    let mut kind_msg = [String::new(), String::new(), String::new()];
    for result in results {
        match result {
            Ok(rows) => {
                for (hash, size) in rows {
                    if cached.iter().any(|have| have == &hash) {
                        continue;
                    }
                    if let Some(size) = size {
                        totals.push((hash.clone(), size));
                    }
                    cached.push(hash);
                }
            }
            Err(err) => {
                failures += 1;
                if let Some(slot) = match err.kind() {
                    "auth" => Some(0),
                    "quota" => Some(1),
                    "rate_limit" => Some(2),
                    _ => None,
                } {
                    kind_n[slot] += 1;
                    kind_msg[slot] = err.message().to_string();
                }
            }
        }
    }
    if total > 0 && failures == total {
        if kind_n[0] == failures {
            return Err(DebridError::Auth(kind_msg[0].clone()));
        }
        if kind_n[1] == failures {
            return Err(DebridError::Quota(kind_msg[1].clone()));
        }
        if kind_n[2] == failures {
            return Err(DebridError::RateLimit {
                message: kind_msg[2].clone(),
                retry_after_ms: None,
            });
        }
        return Err(DebridError::other(
            "nenhum lote de checagem de cache respondeu",
        ));
    }
    Ok(CacheReport {
        cached,
        complete: failures == 0,
        totals,
    })
}

pub(super) async fn check_batch(
    client: &HttpClient,
    base: &str,
    api_key: &str,
    batch: &[String],
    timeout: Duration,
) -> Result<Vec<(String, Option<u64>)>, DebridError> {
    let params: Vec<(&str, &str)> = batch
        .iter()
        .map(|hash| ("items[]", hash.as_str()))
        .collect();
    let data = request(
        client,
        base,
        api_key,
        Method::GET,
        "/cache/check",
        &params,
        None,
        timeout,
    )
    .await?;
    let flags = data.get("response").and_then(Value::as_array);
    let sizes = data.get("filesize").and_then(Value::as_array);
    let mut rows = Vec::new();
    for (idx, hash) in batch.iter().enumerate() {
        if flags
            .and_then(|list| list.get(idx))
            .and_then(Value::as_bool)
            != Some(true)
        {
            continue;
        }
        rows.push((
            hash.clone(),
            sizes.and_then(|list| list.get(idx)).and_then(positive_size),
        ));
    }
    Ok(rows)
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn request(
    client: &HttpClient,
    base: &str,
    api_key: &str,
    method: Method,
    path: &str,
    params: &[(&str, &str)],
    body: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<Value, DebridError> {
    let mut headers = Vec::new();
    if body.is_some() {
        headers.push((
            "Content-Type".into(),
            "application/x-www-form-urlencoded".into(),
        ));
    }
    let mut query = format!("apikey={}", form_encode(api_key));
    for (name, value) in params {
        query.push('&');
        query.push_str(&form_encode(name));
        query.push('=');
        query.push_str(&form_encode(value));
    }
    let data = client
        .json(Call {
            method,
            url: format!("{base}{path}?{query}"),
            headers,
            body,
            timeout,
            abort_safe: false,
        })
        .await?
        .ok_or_else(|| DebridError::other("premiumize retornou erro"))?;
    reject_status(&data)?;
    Ok(data)
}

pub(super) fn reject_status(data: &Value) -> Result<(), DebridError> {
    if !data.is_object() {
        return Err(DebridError::other("premiumize retornou erro"));
    }
    match data.get("status") {
        None | Some(Value::Null) => return Ok(()),
        Some(Value::String(status)) if status.is_empty() || status == "success" => return Ok(()),
        Some(_) => {}
    }
    let code = data.get("code").and_then(Value::as_str).unwrap_or("");
    let message = match data.get("message") {
        Some(Value::String(text)) if !text.is_empty() => text.as_str(),
        _ if !code.is_empty() => code,
        _ => "premiumize retornou erro",
    };
    let full = if !code.is_empty() && !message.contains(code) {
        format!("{message} ({code})")
    } else {
        message.to_string()
    };
    Err(match code {
        "authentication_failed" | "permission_denied" => DebridError::Auth(full),
        "account_limit_reached" => DebridError::Quota(full),
        "rate_limit_reached" => DebridError::RateLimit {
            message: full,
            retry_after_ms: None,
        },
        _ => DebridError::Other(full),
    })
}

pub(super) fn content_of(data: &Value) -> Vec<ContentFile> {
    data.get("content")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(content_item).collect())
        .unwrap_or_default()
}

pub(super) fn content_item(item: &Value) -> Option<ContentFile> {
    if !item.is_object() {
        return None;
    }
    let link = text_of(item.get("stream_link"))
        .or_else(|| text_of(item.get("link")))
        .unwrap_or_default();
    Some(ContentFile {
        path: item
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        size: item.get("size").and_then(positive_size).unwrap_or(0),
        link,
    })
}

pub(super) fn text_of(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    (!text.is_empty()).then(|| text.to_string())
}

pub(super) fn as_debrid(files: &[ContentFile]) -> Vec<DebridFile> {
    files
        .iter()
        .map(|file| DebridFile {
            path: file.path.clone(),
            size: file.size as f64,
        })
        .collect()
}

pub(super) fn positive_size(value: &Value) -> Option<u64> {
    let number = value.as_number()?;
    if let Some(n) = number.as_u64() {
        return (n > 0).then_some(n);
    }
    let n = number.as_f64()?;
    (n.is_finite() && n >= 1.0).then_some(n as u64)
}

pub(super) fn finite(value: Option<&Value>) -> Option<f64> {
    let n = match value? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse().ok()?,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

pub(super) fn choose_magnet(hash: &str, magnet: Option<&str>) -> String {
    if let Some(uri) = magnet {
        let carries = !hash.is_empty()
            && uri
                .to_ascii_lowercase()
                .contains(&hash.to_ascii_lowercase());
        if uri.starts_with("magnet:?") && carries {
            return uri.to_string();
        }
    }
    default_magnet(hash)
}

pub(super) fn lower_set(set: &HashSet<String>) -> HashSet<String> {
    set.iter().map(|item| item.to_lowercase()).collect()
}

/// `URLSearchParams`: espaço vira `+`, o resto percent-encoding em hex maiúsculo.
pub(super) fn form_encode(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char)
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

/// `https` em qualquer host, ou `http` só em 127.0.0.1/localhost. Sem barra final.
pub(super) fn accepted_base(raw: &str) -> Result<String, DebridError> {
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

pub(super) fn base_rejected() -> DebridError {
    DebridError::other("PREMIUMIZE_API_BASE só aceita https ou http em 127.0.0.1/localhost")
}

/// Mensagem do construtor TS; a prova do seletor segue no erro.
pub(super) fn pick_error(
    code: PickCode,
    evidence: Option<EpisodeEvidence>,
    context: Option<EpisodeContext>,
) -> DebridError {
    DebridError::from_pick(code, evidence, context)
}
