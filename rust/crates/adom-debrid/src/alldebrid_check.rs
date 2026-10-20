//! Checagem de cache da AllDebrid: o upload é a consulta, e apagar é o preço.
//! Inventário ausente zera a lista de delete — falso negativo é pior.
//!
//! Contrato do Node (`src/debrid/alldebrid-check.ts` + `common.ts::batched`):
//! lotes de `DEBRID_BATCH_SIZE` (default 25) rodam **em paralelo**, cada um
//! com o MESMO teto de `DEBRID_CACHE_CHECK_TIMEOUT_MS` (default 10 s); um lote
//! que estoura vira `complete:false` sem apagar o ⚡ dos lotes que
//! responderam. O teto da rota `/internal/debrid/check` (500 hashes) também
//! vale aqui: o excedente não é enviado e conta como `complete:false` — nunca
//! como "não está em cache". Falha de limpeza só avisa, como no Node.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use adom_core::{may_delete, DeleteFacts};
use serde_json::Value;
use tokio::task::JoinSet;

use super::{magnet_id, AllDebrid, CHECK_TIMEOUT, DEFAULT_BATCH};
use crate::error::DebridError;

/// Mesmo teto da rota Node (`MAX_HASHES` em `internal-debrid-check.ts`).
pub const MAX_HASHES: usize = 500;

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
    /// `false` = algum lote não respondeu (ou o teto cortou hashes): o que não
    /// está em `cached` é "não perguntado", não "frio".
    pub complete: bool,
    /// Ids cuja remoção foi pedida (não é prova de remoção — o Node também
    /// conta só a tentativa).
    pub deleted: Vec<String>,
    /// `false` só quando NADA foi enviado (todos bloqueados/lista vazia): o
    /// caller pode usar o fallback Node sem risco de segundo upload.
    pub attempted: bool,
}

/// Falha da checagem com a mesma informação de `attempted` do sucesso.
#[derive(Debug)]
pub struct CheckFailure {
    pub error: DebridError,
    pub attempted: bool,
}

impl CheckFailure {
    fn new(error: DebridError, attempted: bool) -> Self {
        Self { error, attempted }
    }
}

struct Piece {
    cached: Vec<String>,
    delete_ids: Vec<String>,
}

/// Cópia própria dos vetos: os lotes rodam em tasks independentes.
struct Gate {
    opts: CheckOpts,
    known: HashSet<String>,
    held: HashSet<String>,
    blocked: HashSet<String>,
}

pub(super) async fn check_cached(
    ad: &AllDebrid,
    api_key: &str,
    hashes: &[String],
    opts: &CheckOpts,
) -> Result<CacheReport, CheckFailure> {
    let gate = Arc::new(Gate {
        opts: opts.clone(),
        known: lower_set(&opts.known_before),
        held: lower_set(&opts.held),
        blocked: lower_set(&opts.blocked),
    });
    let send: Vec<String> = hashes
        .iter()
        .filter(|hash| {
            let lower = hash.to_lowercase();
            !lower.is_empty() && !gate.blocked.contains(&lower)
        })
        .cloned()
        .collect();
    let attempted = !send.is_empty();
    // Teto: o excedente não vai ao serviço e o veredito sai incompleto.
    let overflow = send.len() > MAX_HASHES;
    let send = &send[..send.len().min(MAX_HASHES)];
    let size = batch_size(opts);
    let timeout = timeout_of(opts);
    let (cached, delete_ids, complete) =
        match batches(ad, api_key, send, size, timeout, &gate).await {
            Ok(folded) => folded,
            Err(error) => return Err(CheckFailure::new(error, attempted)),
        };
    if !delete_ids.is_empty() {
        // Igual ao Node: a falha da limpeza não derruba a checagem (o ⚡ já
        // está no retorno). Só o tipo vai ao log; id e hash não.
        if let Err(error) = ad.delete_ids(api_key, &delete_ids).await {
            eprintln!("[alldebrid] limpeza da checagem falhou ({})", error.kind());
        }
    }
    Ok(CacheReport {
        cached,
        complete: complete && !overflow,
        deleted: delete_ids,
        attempted,
    })
}

/// Lotes em paralelo, na ordem do input. `JoinSet` porque o número de lotes é
/// dinâmico; um panic de task vira lote falho, nunca pânico do caller.
async fn batches(
    ad: &AllDebrid,
    api_key: &str,
    send: &[String],
    size: usize,
    timeout: Duration,
    gate: &Arc<Gate>,
) -> Result<(Vec<String>, Vec<String>, bool), DebridError> {
    let batches: Vec<Vec<String>> = send.chunks(size).map(<[String]>::to_vec).collect();
    let mut set = JoinSet::new();
    for (index, batch) in batches.into_iter().enumerate() {
        let ad = ad.clone();
        let key = api_key.to_string();
        let gate = gate.clone();
        set.spawn(async move { (index, upload_batch(&ad, &key, &batch, timeout, &gate).await) });
    }
    let mut parts: Vec<(usize, Result<Piece, DebridError>)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(part) => parts.push(part),
            Err(error) => {
                // Task abortada/panic é LOTE FALHO, nunca "nada em cache":
                // sem esta entrada o fold poderia responder known:true vazio.
                eprintln!(
                    "[alldebrid] lote de checagem abortou (panic={})",
                    error.is_panic()
                );
                parts.push((
                    usize::MAX,
                    Err(DebridError::other("lote de checagem abortou")),
                ));
            }
        }
    }
    parts.sort_by_key(|(index, _)| *index);
    fold(parts.into_iter().map(|(_, part)| part).collect())
}

fn batch_size(opts: &CheckOpts) -> usize {
    opts.batch_size
        .or_else(|| env_usize("DEBRID_BATCH_SIZE"))
        .unwrap_or(DEFAULT_BATCH)
        .clamp(1, MAX_HASHES)
}

fn timeout_of(opts: &CheckOpts) -> Duration {
    opts.timeout
        .or_else(|| env_ms("DEBRID_CACHE_CHECK_TIMEOUT_MS"))
        .unwrap_or(CHECK_TIMEOUT)
        .max(Duration::from_millis(1))
}

fn env_usize(name: &str) -> Option<usize> {
    std::env::var(name)
        .ok()?
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|value| *value > 0)
}

fn env_ms(name: &str) -> Option<Duration> {
    env_usize(name).map(|value| Duration::from_millis(value as u64))
}

async fn upload_batch(
    ad: &AllDebrid,
    api_key: &str,
    batch: &[String],
    timeout: Duration,
    gate: &Gate,
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
fn may_drop(hash: &str, gate: &Gate) -> bool {
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

/// Igual a `batched` do TS: só quando TODOS os lotes falharam o erro sobe, e
/// auth/quota/rate limit só vencem se forem o motivo de todos. Rate limit é
/// transitório (o Node tenta de novo no passe tardio), por isso tem tipo
/// próprio — nunca vira `unusable`.
fn only_failure(parts: &[Result<Piece, DebridError>]) -> DebridError {
    let mut auth = 0usize;
    let mut quota = 0usize;
    let mut rate = 0usize;
    let mut auth_msg = String::new();
    let mut quota_msg = String::new();
    let mut rate_msg = String::new();
    let mut rate_after = None;
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
            "rate_limit" => {
                rate += 1;
                rate_msg = err.message().to_string();
                rate_after = rate_after.or(err.retry_after_ms());
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
    if rate == parts.len() {
        return DebridError::RateLimit {
            message: rate_msg,
            retry_after_ms: rate_after,
        };
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

#[cfg(test)]
#[path = "alldebrid_check_tests.rs"]
mod check_tests;
