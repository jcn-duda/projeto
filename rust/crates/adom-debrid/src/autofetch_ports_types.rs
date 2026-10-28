//! Identidade, capacidades e erro das portas do autofetch v3.
//!
//! Separado de `autofetch_ports.rs` para caber na catraca de linhas (teto 400)
//! e porque `PortError` precisa listar as recusas LOCAIS do Real-Debrid uma a
//! uma: `Quarantined`/`StoreUnavailable`/`Cooldown` não são recusa do serviço.

use crate::alldebrid_cleanup::account_scope;
use crate::error::DebridError;
use crate::realdebrid_autofetch::RdAutofetchError;

/// Dono da porta. O `id` é o prefixo do escopo (`adapter:account`), o mesmo
/// vocabulário do TS para gate, ledger e orçamento de enqueue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Service {
    AllDebrid,
    TorBox,
    Premiumize,
    RealDebrid,
    DebridLink,
}

impl Service {
    pub fn id(self) -> &'static str {
        match self {
            Self::AllDebrid => "alldebrid",
            Self::TorBox => "torbox",
            Self::Premiumize => "premiumize",
            Self::RealDebrid => "realdebrid",
            Self::DebridLink => "debridlink",
        }
    }
}

/// `adapter:sha256(chave)` — identidade de gate/ledger, sem a chave.
pub fn scope_of(service: Service, api_key: &str) -> String {
    format!("{}:{}", service.id(), account_scope(api_key))
}

/// O que a porta REALMENTE sabe fazer. `false` é desligado de propósito, nunca
/// "sucesso vazio": quem consome precisa ver a capacidade desligada.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub enqueue: bool,
    pub status: bool,
    /// A porta responde `check` (mesmo que só com `known:false`).
    pub check: bool,
    /// `true` somente quando `check` tem como PROVAR `known:true`.
    pub cache_known: bool,
    pub remove: bool,
    /// `false` nos cinco: nenhum adaptador apaga POR HASH (o delete é por id e
    /// a posse/hold pertence ao dono do inventário).
    pub evict: bool,
    pub account: bool,
}

#[derive(Debug)]
pub enum PortError {
    /// Capacidade não existe neste serviço. Nunca vira lista vazia/sucesso.
    Unsupported(&'static str),
    /// Entrada sem prova suficiente (id/hash vazio ou fora do formato).
    InvalidInput(&'static str),
    /// Recusa ou falha do adaptador (`auth`, `quota`, `rate_limit`, ...).
    Debrid(DebridError),
    /// Real-Debrid: quarentena, store local ou cooldown do gate.
    Rd(RdAutofetchError),
}

impl PortError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Unsupported(_) => "unsupported",
            Self::InvalidInput(_) => "invalid_input",
            Self::Debrid(error) => error.kind(),
            Self::Rd(RdAutofetchError::Debrid(error)) => error.kind(),
            Self::Rd(error) => rd_local(error).0,
        }
    }
}

/// `(kind, texto)` das recusas locais do RD — uma lista só para `kind()` e
/// `Display`, sem dois matches sobre os mesmos braços.
fn rd_local(error: &RdAutofetchError) -> (&'static str, &'static str) {
    match error {
        RdAutofetchError::InvalidInput => ("invalid_input", "entrada inválida"),
        RdAutofetchError::Quarantined => (
            "quarantined",
            "escrita anterior de resultado incerto (quarentena)",
        ),
        RdAutofetchError::StoreUnavailable => ("store_unavailable", "store do intent indisponível"),
        RdAutofetchError::Cooldown => ("cooldown", "conta em cooldown"),
        RdAutofetchError::TaskFailed => ("task_failed", "tarefa do gate falhou"),
        // Já tratado em `kind()`/`Display` pelo braço `Debrid`.
        RdAutofetchError::Debrid(_) => ("other", "falha do serviço"),
    }
}

impl std::fmt::Display for PortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(what) => write!(f, "capacidade desligada: {what}"),
            Self::InvalidInput(what) => write!(f, "entrada inválida: {what}"),
            Self::Debrid(error) => write!(f, "debrid: {error}"),
            Self::Rd(RdAutofetchError::Debrid(error)) => write!(f, "real-debrid: {error}"),
            Self::Rd(error) => write!(f, "real-debrid: {}", rd_local(error).1),
        }
    }
}

impl std::error::Error for PortError {}

/// A recusa do adaptador entra como `Debrid`, não como capacidade desligada:
/// o serviço respondeu, só não aceitou.
impl From<DebridError> for PortError {
    fn from(error: DebridError) -> Self {
        Self::Debrid(error)
    }
}

#[cfg(test)]
#[path = "autofetch_ports_types_tests.rs"]
mod tests;
