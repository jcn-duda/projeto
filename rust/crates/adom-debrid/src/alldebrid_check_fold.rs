//! Lotes paralelos da checagem AllDebrid e dobra do resultado.
//!
//! Cada lote sobe o `/magnet/upload` e devolve o que o plano manda apagar; o
//! `fold` preserva a ordem do input e transforma qualquer lote falho em
//! `complete:false` — lote perdido nunca vira "nada em cache".

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::task::JoinSet;

use super::{AllDebrid, Gate};
use crate::alldebrid::parse::magnet_id;
use crate::alldebrid_cleanup::{classify_drop, remember_submitted, CleanTarget, DropVerdict};
use crate::error::{now_ms, DebridError};

/// Resultado de um lote: o ⚡ confirmado e o que o plano manda apagar.
#[derive(Default)]
struct Piece {
    cached: Vec<String>,
    /// Hashes que o upload ACEITOU e o snapshot provou novos (posse `adsub`).
    submitted: Vec<String>,
    ready: Vec<CleanTarget>,
    uncached: Vec<CleanTarget>,
    protected: usize,
    known: usize,
}

#[derive(Default)]
pub(super) struct Folded {
    pub(super) cached: Vec<String>,
    pub(super) submitted: Vec<String>,
    pub(super) ready: Vec<CleanTarget>,
    pub(super) uncached: Vec<CleanTarget>,
    pub(super) protected: usize,
    pub(super) known: usize,
    pub(super) complete: bool,
}

/// Lotes em paralelo, na ordem do input. `JoinSet` porque o número de lotes é
/// dinâmico; um panic de task vira lote falho, nunca pânico do caller.
pub(super) async fn batches(
    ad: &AllDebrid,
    api_key: &str,
    send: &[String],
    size: usize,
    timeout: Duration,
    gate: &Arc<Gate>,
) -> Result<Folded, DebridError> {
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
    let mut piece = Piece::default();
    let Some(list) = data.get("magnets").and_then(Value::as_array) else {
        return Ok(piece);
    };
    let now = now_ms() as i64;
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
        let run = gate.cleanup.as_ref().filter(|run| run.active());
        if let Some(run) = run {
            // Posse (8.15): só o que o snapshot prova NÃO estar na conta vira
            // "nosso"; o upload é idempotente e não diz se criou ou reaproveitou.
            if run
                .inventory
                .as_ref()
                .is_some_and(|snapshot| !snapshot.contains(&hash))
            {
                remember_submitted(&run.account, &hash);
                // A prova de criação é DAQUI (o hash não estava no snapshot):
                // o Node grava a posse sem repetir a conta.
                if !piece.submitted.contains(&hash) {
                    piece.submitted.push(hash.clone());
                }
            }
            let flagged = if ready {
                run.gate.drop_ready
            } else {
                run.gate.drop_uncached
            };
            if !flagged {
                continue;
            }
            let Some(id) = magnet_id(magnet) else {
                continue;
            };
            match classify_drop(&run.gate, run.inventory.as_deref(), &hash, &id, now) {
                DropVerdict::Delete(mut target) => {
                    // O nome viaja com o alvo até o `adrm` do Node: é por ele
                    // que a origem BR é reconhecida e NUNCA marcada (8.4).
                    target.name = magnet
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .map(str::to_string);
                    let list = if ready {
                        &mut piece.ready
                    } else {
                        &mut piece.uncached
                    };
                    if !list.iter().any(|item| item.id == target.id) {
                        list.push(target);
                    }
                }
                DropVerdict::Protected => piece.protected += 1,
                DropVerdict::KnownBefore => piece.known += 1,
                DropVerdict::NoInventory => {}
            }
        }
    }
    Ok(piece)
}

fn fold(parts: Vec<Result<Piece, DebridError>>) -> Result<Folded, DebridError> {
    if !parts.is_empty() && parts.iter().all(|part| part.is_err()) {
        return Err(only_failure(&parts));
    }
    let mut folded = Folded::default();
    let mut failed = false;
    for part in parts {
        match part {
            Ok(piece) => {
                for hash in piece.cached {
                    if !folded.cached.contains(&hash) {
                        folded.cached.push(hash);
                    }
                }
                for hash in piece.submitted {
                    if !folded.submitted.contains(&hash) {
                        folded.submitted.push(hash);
                    }
                }
                for target in piece.ready {
                    if !folded.ready.iter().any(|item| item.id == target.id) {
                        folded.ready.push(target);
                    }
                }
                for target in piece.uncached {
                    if !folded.uncached.iter().any(|item| item.id == target.id) {
                        folded.uncached.push(target);
                    }
                }
                folded.protected += piece.protected;
                folded.known += piece.known;
            }
            Err(_) => failed = true,
        }
    }
    folded.complete = !failed;
    Ok(folded)
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

pub(super) fn lower_set(set: &HashSet<String>) -> HashSet<String> {
    set.iter().map(|item| item.to_lowercase()).collect()
}
