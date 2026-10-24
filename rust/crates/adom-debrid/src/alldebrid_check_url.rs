//! URL e validação da base da AllDebrid (query com `agent`, recusa de base).
//!
//! `https` em qualquer host, ou `http` só em loopback: a base vem de env e
//! nunca pode levar a chave para um host arbitrário em texto claro.

use crate::error::DebridError;

pub(crate) fn query_url(base: &str, path: &str, params: &[(&str, &str)]) -> String {
    let mut url = format!("{base}{path}?agent={}", form_encode(super::super::AGENT));
    for (key, value) in params {
        url.push('&');
        url.push_str(&form_encode(key));
        url.push('=');
        url.push_str(&form_encode(value));
    }
    url
}

/// `URLSearchParams`: espaço vira `+`.
fn form_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char)
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

/// `https` em qualquer host, ou `http` só em 127.0.0.1/localhost. Sem barra final.
pub(crate) fn accepted_base(raw: &str) -> Result<String, DebridError> {
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

pub(crate) fn base_rejected() -> DebridError {
    DebridError::other("ALLDEBRID_API_BASE só aceita https ou http em 127.0.0.1/localhost")
}
