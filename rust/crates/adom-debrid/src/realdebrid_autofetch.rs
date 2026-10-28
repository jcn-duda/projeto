//! Primitivos RD do autofetch com gate e intent durável obrigatório.
//!
//! O gateway ainda precisa fornecer `RdUncertainStore` sobre NativeKv e passar
//! o mesmo executor ao play e ao worker antes de ligar chamadas remotas.
//!
//! Contrato de escrita (as três regras que não podem regredir):
//! 1. Toda escrita na conta passa pelo `RdGateExecutor` COMPARTILHADO (o clone
//!    da instância do play nativo) — gate próprio não serializa a conta.
//! 2. O intent durável entra ANTES do HTTP e só sai com prova: marker/`owns`
//!    (`acknowledge_marker`), remoção confirmada, recusa definitiva ou
//!    reconciliação com snapshot completo (`reconcile`).
//! 3. Timeout/resposta incerta NUNCA vira reenvio cego: o hash fica em
//!    quarentena (`Quarantined`) até uma das provas acima.
//! Falha do store fecha o caminho (`StoreUnavailable`) — jamais "segue sem
//! intent".

use std::sync::Arc;
use std::time::Duration;

use adom_core::{GatePriority, PlayHint};
use serde::{Deserialize, Serialize};

use crate::error::DebridError;
use crate::rd_gate_executor::{RdGateExecutor, RdRunError};
use crate::rd_scheduler::RdOutcome;
use crate::realdebrid::RealDebrid;

#[path = "realdebrid_autofetch_transport.rs"]
mod transport;

use transport::InnerError;

const UNCERTAIN_PREFIX: &str = "rdq:v1:uncertain:";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RdWriteKind {
    Enqueue,
    Remove,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RdUncertainIntent {
    pub kind: RdWriteKind,
    pub created_at_ms: i64,
}

/// Adapter NativeKv: `put_intent_if_absent` deve ser atômico e permanente.
pub trait RdUncertainStore: Send + Sync + 'static {
    fn has_intent(&self, key: &str) -> Result<bool, String>;
    fn put_intent_if_absent(&self, key: &str, intent: &RdUncertainIntent) -> Result<bool, String>;
    fn clear_intent(&self, key: &str) -> Result<(), String>;
    fn owns_transfer(&self, account_scope: &str, hash: &str, id: &str) -> Result<bool, String>;
}

#[derive(Debug, PartialEq)]
pub enum RdAutofetchError {
    InvalidInput,
    Quarantined,
    StoreUnavailable,
    Cooldown,
    TaskFailed,
    Debrid(DebridError),
}

#[derive(Clone)]
pub struct RealDebridAutofetch {
    gate: RdGateExecutor,
    uncertain: Arc<dyn RdUncertainStore>,
}

impl RealDebridAutofetch {
    /// Passe o clone da instância do gate usada pelo play nativo: uma instância
    /// própria (gate() novo) deixaria a conta com dois serializadores e o AIMD
    /// mentiria sobre gap/cooldown.
    pub fn new(gate: RdGateExecutor, uncertain: Arc<dyn RdUncertainStore>) -> Self {
        Self { gate, uncertain }
    }

    /// Intent permanece até `acknowledge_marker` confirmar o marker durável.
    pub async fn enqueue(
        &self,
        rd: Arc<RealDebrid>,
        api_key: &str,
        hash: &str,
        magnet: Option<&str>,
        hint: &PlayHint,
        poll_wait: Duration,
    ) -> Result<Option<String>, RdAutofetchError> {
        let (account, hash) = transport::validate(api_key, hash)?;
        let key = uncertain_key(&account, &hash);
        if self
            .uncertain
            .has_intent(&key)
            .map_err(|_| RdAutofetchError::StoreUnavailable)?
        {
            return Err(RdAutofetchError::Quarantined);
        }
        let store = self.uncertain.clone();
        let api_key = api_key.to_string();
        let magnet = transport::validated_magnet(&hash, magnet);
        let hint = hint.clone();
        let result = self
            .gate
            .run(&account, GatePriority::Autofetch, move || async move {
                let result =
                    transport::enqueue_inner(rd, store, key, api_key, magnet, hint, poll_wait)
                        .await;
                let outcome = gate_outcome(&result);
                (result, outcome)
            })
            .await
            .map_err(map_gate_error)?;
        map_inner(result)
    }

    /// Remove exige ID associado ao marker e grava intent antes do DELETE.
    pub async fn remove(
        &self,
        rd: Arc<RealDebrid>,
        api_key: &str,
        hash: &str,
        id: &str,
    ) -> Result<bool, RdAutofetchError> {
        let (account, hash) = transport::validate(api_key, hash)?;
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) || id == "0" {
            return Err(RdAutofetchError::InvalidInput);
        }
        let key = uncertain_key(&account, &hash);
        let store = self.uncertain.clone();
        let api_key = api_key.to_string();
        let id = id.to_string();
        let gate_key = account.clone();
        let result = self
            .gate
            .run(&gate_key, GatePriority::Cleanup, move || async move {
                let result =
                    transport::remove_inner(rd, store, account, hash, key, api_key, id).await;
                // `Ok(false)` = nada foi escrito (posse de outro transfer): não é
                // sucesso do RD. `Error` aqui só libera a conta — não mexe em
                // gap nem na contagem de sucessos do AIMD.
                let outcome = match &result {
                    Ok(false) => RdOutcome::Error,
                    other => gate_outcome(other),
                };
                (result, outcome)
            })
            .await
            .map_err(map_gate_error)?;
        map_inner(result)
    }

    /// Solta intent somente se o marker durável comprovar conta/hash/ID.
    pub fn acknowledge_marker(
        &self,
        api_key: &str,
        hash: &str,
        id: &str,
    ) -> Result<bool, RdAutofetchError> {
        let (account, hash) = transport::validate(api_key, hash)?;
        if !self
            .uncertain
            .owns_transfer(&account, &hash, id)
            .map_err(|_| RdAutofetchError::StoreUnavailable)?
        {
            return Ok(false);
        }
        self.uncertain
            .clear_intent(&uncertain_key(&account, &hash))
            .map_err(|_| RdAutofetchError::StoreUnavailable)?;
        Ok(true)
    }

    /// Só snapshot completo, após a janela de visibilidade, pode liberar hash ausente.
    pub fn reconcile(
        &self,
        api_key: &str,
        hash: &str,
        snapshot: RdHashSnapshot,
    ) -> Result<bool, RdAutofetchError> {
        let (account, hash) = transport::validate(api_key, hash)?;
        if snapshot != RdHashSnapshot::CompleteAbsent {
            return Ok(false);
        }
        self.uncertain
            .clear_intent(&uncertain_key(&account, &hash))
            .map_err(|_| RdAutofetchError::StoreUnavailable)?;
        Ok(true)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RdHashSnapshot {
    Unknown,
    Present,
    CompleteAbsent,
}

pub fn uncertain_key(account_scope: &str, hash: &str) -> String {
    format!(
        "{UNCERTAIN_PREFIX}{account_scope}:{}",
        hash.to_ascii_lowercase()
    )
}

fn gate_outcome<T>(result: &Result<T, InnerError>) -> RdOutcome {
    match result {
        Ok(_) => RdOutcome::Success,
        Err(InnerError::Debrid(DebridError::RateLimit { retry_after_ms, .. })) => {
            RdOutcome::RateLimit(retry_after_ms.map(|ms| ms as f64))
        }
        // `Error` no agendador NÃO penaliza o AIMD (não dobra gap nem abre
        // cooldown): falha local e recusa definitiva só liberam a conta.
        Err(_) => RdOutcome::Error,
    }
}

/// Falha local não pode virar `Debrid`: o worker precisa distinguir "o serviço
/// recusou" de "não consegui registrar o intent".
fn map_inner<T>(result: Result<T, InnerError>) -> Result<T, RdAutofetchError> {
    result.map_err(|error| match error {
        InnerError::Quarantined => RdAutofetchError::Quarantined,
        InnerError::Store => RdAutofetchError::StoreUnavailable,
        InnerError::Debrid(err) => RdAutofetchError::Debrid(err),
    })
}

fn map_gate_error(error: RdRunError) -> RdAutofetchError {
    match error {
        RdRunError::Cooldown => RdAutofetchError::Cooldown,
        RdRunError::Task(_) => RdAutofetchError::TaskFailed,
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
#[path = "realdebrid_autofetch_tests.rs"]
mod tests;
