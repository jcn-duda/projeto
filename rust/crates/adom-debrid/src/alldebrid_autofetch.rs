//! Upload, status e remoção individuais para o worker nativo; sem agendamento.
//! Aqui mora só o PRIMITIVO do upload: posse, anti-reupload e limpeza são
//! decisões do chamador, que é quem conhece o snapshot da conta.
use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::{AllDebrid, CALL_TIMEOUT};
use crate::error::DebridError;

#[path = "alldebrid_autofetch_guard.rs"]
mod guard;
pub use guard::{guard_evidence, read_adrm_block};

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

/// Resposta crua do `/magnet/upload`, sem interpretação de posse.
///
/// `accepted` é só "o serviço listou o magnet" (recusa volta como lista vazia,
/// não como erro). `ready` é o cache do AllDebrid — o mesmo endpoint que
/// responde pronto é o que enfileira o download que falta. Quem chama decide o
/// que fazer com isso: retry, limpeza e etiqueta de posse NÃO moram aqui.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadOutcome {
    pub accepted: bool,
    pub id: Option<String>,
    pub ready: bool,
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
            let id = id_string(m.get("id"));
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

    /// Enfileira um magnet na conta e devolve o que o serviço respondeu.
    ///
    /// É o upload que a checagem já faz de propósito (a AllDebrid não tem
    /// consulta de cache), aqui isolado para o worker do Chupim. Sem retry e
    /// sem limpeza: reenviar um hash recusado duplicaria lixo e apagar um
    /// magnet que o usuário tinha antes é perda irreversível — as duas
    /// decisões precisam do inventário, que só o chamador tem.
    ///
    /// Hash vazio não gera requisição: o serviço criaria um magnet sem hash
    /// para casar depois, e o chamador receberia um aceite que não é dele.
    pub async fn upload_magnet(
        &self,
        key: &str,
        info_hash: &str,
    ) -> Result<UploadOutcome, DebridError> {
        // O memo de posse e o status comparam em minúsculas; subir em caixa
        // alta criaria duas linhas para o mesmo torrent na conta.
        let hash = info_hash.trim().to_lowercase();
        if hash.is_empty() {
            return Ok(UploadOutcome {
                accepted: false,
                id: None,
                ready: false,
            });
        }
        let data = self
            .call(
                key,
                "/magnet/upload",
                &[("magnets[]", hash.as_str())],
                CALL_TIMEOUT,
                false,
            )
            .await?;
        // `magnets` é array no upload; lista vazia é a recusa do serviço (não é
        // erro de rede, então não vira `Err`).
        let Some(magnet) = data
            .get("magnets")
            .and_then(Value::as_array)
            .and_then(|list| list.first())
        else {
            return Ok(UploadOutcome {
                accepted: false,
                id: None,
                ready: false,
            });
        };
        let raw = magnet.get("status").and_then(Value::as_str).unwrap_or("");
        Ok(UploadOutcome {
            accepted: true,
            id: id_string(magnet.get("id")),
            // Mesmo predicado do status da conta: booleano "de verdade" ou o
            // texto `Ready` (a API alterna entre os dois).
            ready: truthy(magnet.get("ready")) || raw.eq_ignore_ascii_case("ready"),
        })
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

/// `id` do magnet vem como string OU número, dependendo do endpoint; o delete
/// usa o texto e por isso a conversão é a mesma aqui e no status.
fn id_string(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
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
