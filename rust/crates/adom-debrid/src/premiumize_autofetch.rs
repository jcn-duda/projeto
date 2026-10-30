//! Operações do autofetch Premiumize. Nenhuma chamada é agendada aqui.
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::{choose_magnet, form_encode, Premiumize, CALL_TIMEOUT};
use crate::error::DebridError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransferState {
    Ready,
    Downloading,
    Dead,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransferStatus {
    pub state: TransferState,
    pub stalled: bool,
    pub id: Option<String>,
    pub via_id: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TransferStatusReport {
    pub transfers: HashMap<String, TransferStatus>,
    pub via_id: usize,
    pub unmatched: usize,
}

impl Premiumize {
    /// Aceite requer id: ele é a prova para reconhecer a transferência no recheck.
    pub async fn enqueue(
        &self,
        key: &str,
        hash: &str,
        magnet: Option<&str>,
    ) -> Result<Option<String>, DebridError> {
        let body = format!("src={}", form_encode(&choose_magnet(hash, magnet))).into_bytes();
        let data = self
            .get(key, "/transfer/create", &[], Some(body), CALL_TIMEOUT)
            .await?;
        Ok(data.get("id").and_then(scalar).filter(|s| !s.is_empty()))
    }

    /// `ids` associa hash ao id devolvido pelo enqueue; não inferir hash de nome livre.
    pub async fn torrent_status(
        &self,
        key: &str,
        ids: &HashMap<String, String>,
    ) -> Result<TransferStatusReport, DebridError> {
        let data = self
            .get(key, "/transfer/list", &[], None, CALL_TIMEOUT)
            .await?;
        let by_id: HashMap<String, String> = ids
            .iter()
            .filter(|(_, id)| !id.is_empty())
            .map(|(hash, id)| (id.clone(), hash.to_lowercase()))
            .collect();
        let mut report = TransferStatusReport::default();
        for transfer in data
            .get("transfers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some((hash, via_id)) = transfer_hash(transfer, &by_id) else {
                report.unmatched += 1;
                continue;
            };
            if via_id {
                report.via_id += 1;
            }
            let status = transfer
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let state = match status.as_str() {
                "finished" | "seeding" => TransferState::Ready,
                "queued" | "running" => TransferState::Downloading,
                "error" => TransferState::Dead,
                _ => TransferState::Unknown,
            };
            let progress = transfer.get("progress").and_then(number).unwrap_or(0.0);
            let message = transfer
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("");
            let stalled = status == "running" && progress == 0.0 && STALLED.is_match(message);
            report.transfers.insert(
                hash,
                TransferStatus {
                    state,
                    stalled,
                    id: transfer.get("id").and_then(scalar),
                    via_id,
                },
            );
        }
        Ok(report)
    }

    /// O chamador deve manter as guardas de posse e hold antes de remover.
    pub async fn remove_torrent(&self, key: &str, id: &str) -> Result<(), DebridError> {
        let body = format!("id={}", form_encode(id)).into_bytes();
        self.get(key, "/transfer/delete", &[], Some(body), CALL_TIMEOUT)
            .await
            .map(|_| ())
    }
}

static SRC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)btih:([a-f0-9]{40})").unwrap());
static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|[\s._-])([a-f0-9]{40})(?:[\s._-]|$)").unwrap());
static HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-f0-9]{40}$").unwrap());
pub(crate) static STALLED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)0 bytes of 0 bytes|from 0 peer").unwrap());

pub(crate) fn transfer_hash(t: &Value, by_id: &HashMap<String, String>) -> Option<(String, bool)> {
    let src = t.get("src").and_then(Value::as_str).unwrap_or("");
    if let Some(c) = SRC.captures(src) {
        return Some((c[1].to_lowercase(), false));
    }
    if let Some(hash) = t.get("id").and_then(scalar).and_then(|id| by_id.get(&id)) {
        return Some((hash.clone(), true));
    }
    let name = t.get("name").and_then(Value::as_str).unwrap_or("");
    if let Some(c) = NAME.captures(name) {
        return Some((c[1].to_lowercase(), false));
    }
    let direct = t
        .get("hash")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| t.get("info_hash").and_then(Value::as_str))
        .unwrap_or("");
    HASH.is_match(direct)
        .then(|| (direct.to_lowercase(), false))
}

pub(crate) fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

pub(crate) fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
    .filter(|n: &f64| n.is_finite())
}

#[cfg(test)]
#[path = "premiumize_autofetch_tests.rs"]
mod tests;
