//! Status e remoção individuais para um futuro worker; sem agendamento.
//! Upload exige primeiro os contratos de posse e anti-reupload e não está aqui.
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::{AllDebrid, CALL_TIMEOUT};
use crate::error::DebridError;

#[path = "alldebrid_autofetch_guard.rs"]
mod guard;
pub use guard::read_adrm_block;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AutofetchState {
    Ready,
    Downloading,
    Dead,
    Unknown,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AutofetchProgress {
    pub bytes: f64,
    pub total: f64,
    pub speed: f64,
    pub seeders: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AutofetchStatus {
    pub state: AutofetchState,
    pub id: Option<String>,
    pub progress: Option<AutofetchProgress>,
}

/// Fatos adquiridos pelo worker ANTES da chamada; uma consulta fracassada não
/// pode ser representada como `false` nem como inventário comprovadamente novo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReuploadEvidence {
    Unavailable,
    Clear,
    Blocked,
    BlockedButInventoryReady,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnqueueDecision {
    /// A guarda não pôde ser lida: nenhuma requisição será autorizada.
    GuardUnavailable,
    Blocked,
    /// Limpar adrm só depois de confirmar a prova de inventário ao vivo.
    AlreadyReady,
    Upload,
}

/// Esta decisão não executa o upload, não limpa adrm e não etiqueta posse.
pub fn enqueue_decision(evidence: ReuploadEvidence) -> EnqueueDecision {
    match evidence {
        ReuploadEvidence::Unavailable => EnqueueDecision::GuardUnavailable,
        ReuploadEvidence::Blocked => EnqueueDecision::Blocked,
        ReuploadEvidence::BlockedButInventoryReady => EnqueueDecision::AlreadyReady,
        ReuploadEvidence::Clear => EnqueueDecision::Upload,
    }
}

/// Só um snapshot anterior e completo que não contém o hash prova posse.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provenance {
    Unavailable,
    Preexisting,
    New,
}

pub fn should_mark_owned(upload_accepted: bool, provenance: Provenance) -> bool {
    upload_accepted && provenance == Provenance::New
}

impl AllDebrid {
    /// O hash da listagem é autoridade; statusCode não condena magnet.
    pub async fn torrent_status(
        &self,
        key: &str,
    ) -> Result<HashMap<String, AutofetchStatus>, DebridError> {
        let data = self
            .call(key, "/magnet/status", &[], CALL_TIMEOUT, false)
            .await?;
        let mut out = HashMap::new();
        for m in data
            .get("magnets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let hash = m
                .get("hash")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            if hash.is_empty() {
                continue;
            }
            let raw = m.get("status").and_then(Value::as_str).unwrap_or("");
            let state = if truthy(m.get("ready")) || raw.eq_ignore_ascii_case("ready") {
                AutofetchState::Ready
            } else if DEAD.is_match(raw) {
                AutofetchState::Dead
            } else if ACTIVE.is_match(raw) {
                AutofetchState::Downloading
            } else {
                AutofetchState::Unknown
            };
            let progress = if raw == "Downloading" {
                progress(m)
            } else {
                None
            };
            let id = m.get("id").and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            });
            out.insert(
                hash,
                AutofetchStatus {
                    state,
                    id,
                    progress,
                },
            );
        }
        Ok(out)
    }

    /// Uma operação; o chamador garante posse e proteção antes de usá-la.
    pub async fn remove_torrent(&self, key: &str, id: &str) -> Result<(), DebridError> {
        self.delete_ids(key, &[id.to_string()]).await
    }
}

fn progress(m: &Value) -> Option<AutofetchProgress> {
    let get = |name: &str| {
        m.get(name)
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
    };
    let (bytes, total, speed, seeders) = (
        get("downloaded")?,
        get("size")?,
        get("downloadSpeed")?,
        get("seeders")?,
    );
    (total > 0.0 && bytes < total).then_some(AutofetchProgress {
        bytes,
        total,
        speed,
        seeders,
    })
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}

static DEAD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("(?i)no peer|expired|not available|error|failed|download took more than 3 days")
        .unwrap()
});
static ACTIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("(?i)^(?:queued|downloading|processing|compressing|moving|uploading)$").unwrap()
});

#[cfg(test)]
#[path = "alldebrid_autofetch_tests.rs"]
mod tests;
