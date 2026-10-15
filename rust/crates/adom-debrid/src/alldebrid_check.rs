//! Checagem de cache da AllDebrid: o upload é a consulta, e apagar é o preço.
//! Inventário ausente zera a lista de delete — falso negativo é pior.

use std::collections::HashSet;
use std::time::Duration;

use adom_core::{may_delete, DeleteFacts};
use serde_json::Value;

use super::{magnet_id, AllDebrid, CHECK_TIMEOUT, DEFAULT_BATCH};
use crate::error::DebridError;

#[derive(Debug, Clone, Default)]
pub struct CheckOpts {
    pub timeout: Option<Duration>,
    pub batch_size: Option<usize>,
    pub drop_ready: bool,
    pub drop_uncached: bool,
    pub inventory_loaded: bool,
    pub known_before: HashSet<String>,
    pub held: HashSet<String>,
    pub blocked: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheReport {
    pub cached: Vec<String>,
    pub complete: bool,
    pub deleted: Vec<String>,
}

struct Piece {
    cached: Vec<String>,
    delete_ids: Vec<String>,
}

struct Gate<'a> {
    opts: &'a CheckOpts,
    known: HashSet<String>,
    held: HashSet<String>,
    blocked: HashSet<String>,
}

pub(super) async fn check_cached(
    ad: &AllDebrid,
    api_key: &str,
    hashes: &[String],
    opts: &CheckOpts,
) -> Result<CacheReport, DebridError> {
    let gate = Gate {
        opts,
        known: lower_set(&opts.known_before),
        held: lower_set(&opts.held),
        blocked: lower_set(&opts.blocked),
    };
    let send: Vec<String> = hashes
        .iter()
        .filter(|hash| {
            let lower = hash.to_lowercase();
            !lower.is_empty() && !gate.blocked.contains(&lower)
        })
        .cloned()
        .collect();
    let size = opts.batch_size.unwrap_or(DEFAULT_BATCH).max(1);
    let timeout = opts.timeout.unwrap_or(CHECK_TIMEOUT);
    let mut parts = Vec::new();
    for batch in send.chunks(size) {
        parts.push(upload_batch(ad, api_key, batch, timeout, &gate).await);
    }
    let (cached, delete_ids, complete) = fold(parts)?;
    if !delete_ids.is_empty() {
        ad.delete_ids(api_key, &delete_ids).await?;
    }
    Ok(CacheReport {
        cached,
        complete,
        deleted: delete_ids,
    })
}

async fn upload_batch(
    ad: &AllDebrid,
    api_key: &str,
    batch: &[String],
    timeout: Duration,
    gate: &Gate<'_>,
) -> Result<Piece, DebridError> {
    let params: Vec<(&str, &str)> = batch
        .iter()
        .map(|hash| ("magnets[]", hash.as_str()))
        .collect();
    // abort_safe: largar a espera da busca não cancela o upload já enviado.
    let data = ad
        .call(api_key, "/magnet/upload", &params, timeout, true)
        .await?;
    let mut piece = Piece {
        cached: Vec::new(),
        delete_ids: Vec::new(),
    };
    let Some(list) = data.get("magnets").and_then(Value::as_array) else {
        return Ok(piece);
    };
    for magnet in list {
        let hash = magnet
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let ready = magnet.get("ready").and_then(Value::as_bool) == Some(true);
        if hash.is_empty() {
            continue;
        }
        if ready && !piece.cached.contains(&hash) {
            piece.cached.push(hash.clone());
        }
        let flagged = if ready {
            gate.opts.drop_ready
        } else {
            gate.opts.drop_uncached
        };
        if !flagged {
            continue;
        }
        let Some(id) = magnet_id(magnet) else {
            continue;
        };
        if may_drop(&hash, gate) && !piece.delete_ids.contains(&id) {
            piece.delete_ids.push(id);
        }
    }
    Ok(piece)
}

/// Os três vetos: inventário ausente, acervo do usuário, hold.
fn may_drop(hash: &str, gate: &Gate<'_>) -> bool {
    may_delete(DeleteFacts {
        inventory_loaded: gate.opts.inventory_loaded,
        known_before: gate.known.contains(hash),
        protected: gate.held.contains(hash),
    })
}

fn fold(
    parts: Vec<Result<Piece, DebridError>>,
) -> Result<(Vec<String>, Vec<String>, bool), DebridError> {
    if !parts.is_empty() && parts.iter().all(|part| part.is_err()) {
        return Err(only_failure(&parts));
    }
    let mut cached = Vec::new();
    let mut delete_ids = Vec::new();
    let mut failed = false;
    for part in parts {
        match part {
            Ok(piece) => {
                for hash in piece.cached {
                    if !cached.contains(&hash) {
                        cached.push(hash);
                    }
                }
                for id in piece.delete_ids {
                    if !delete_ids.contains(&id) {
                        delete_ids.push(id);
                    }
                }
            }
            Err(_) => failed = true,
        }
    }
    Ok((cached, delete_ids, !failed))
}

fn only_failure(parts: &[Result<Piece, DebridError>]) -> DebridError {
    let mut auth = 0usize;
    let mut quota = 0usize;
    let mut auth_msg = String::new();
    let mut quota_msg = String::new();
    for part in parts {
        let Err(err) = part else { continue };
        match err.kind() {
            "auth" => {
                auth += 1;
                auth_msg = err.message().to_string();
            }
            "quota" => {
                quota += 1;
                quota_msg = err.message().to_string();
            }
            _ => {}
        }
    }
    if auth == parts.len() {
        return DebridError::Auth(auth_msg);
    }
    if quota == parts.len() {
        return DebridError::Quota(quota_msg);
    }
    DebridError::other("nenhum lote de checagem de cache respondeu")
}

fn lower_set(set: &HashSet<String>) -> HashSet<String> {
    set.iter().map(|item| item.to_lowercase()).collect()
}

pub(super) fn query_url(base: &str, path: &str, params: &[(&str, &str)]) -> String {
    let mut url = format!("{base}{path}?agent={}", form_encode(super::AGENT));
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
    DebridError::other("ALLDEBRID_API_BASE só aceita https ou http em 127.0.0.1/localhost")
}
