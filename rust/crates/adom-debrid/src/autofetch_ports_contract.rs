//! Cópia fiel do CONTRATO de dados de `adom_autofetch::v3::debrid`, mantida
//! aqui por um motivo estrutural, não por gosto:
//!
//! `adom-debrid` NÃO pode depender de `adom-autofetch`. O grafo do workspace
//! fecha um ciclo duro de pacotes —
//! `adom-autofetch` → `adom-store` (`crates/adom-autofetch/Cargo.toml:12`) →
//! `adom-search` (`crates/adom-store/Cargo.toml:14`) → `adom-debrid`
//! (`crates/adom-search/Cargo.toml:12`) — e o Cargo recusa "cyclic package
//! dependency" (nenhuma feature quebra ciclo de pacote).
//!
//! Consequência de projeto: os CINCO adaptadores e as seis operações vivem
//! aqui (`AutofetchPorts`), com a MESMA forma de dados do contrato; o
//! `impl adom_autofetch::v3::AutofetchDebrid for AutofetchPorts` é delegação
//! pura (`Box::pin(self.enqueue(...))` e companhia) e tem de morar no crate que
//! consegue ver os dois lados — `adom-server/src/autofetch`, junto da fábrica
//! por conta. Enquanto isso, estes tipos são o
//! ABI do crate: qualquer divergência de campo ou de semântica em relação a
//! `adom_autofetch::v3::debrid` é bug, não liberdade.
//!
//! Semânticas que vêm de lá e NÃO podem ser afrouxadas:
//!
//! - `CacheEvidence::known == false` é "desconhecido", jamais "lista de misses".
//! - `AccountEvidence::used == None` é ocupação desconhecida, jamais zero
//!   inferido.
//! - `TorrentEvidence::state` só condena quando é explícito (`dead`); ausência
//!   no snapshot é `unknown`.
//! - `via_id` diz que a identificação veio SÓ do id, não do hash.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

pub type DebridFuture<'a, T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnqueueEvidence {
    pub accepted: bool,
    pub transfer_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheEvidence {
    /// `false` é desconhecido, não uma lista de misses.
    pub known: bool,
    pub cached: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TorrentEvidence {
    /// `ready`, `dead`, `downloading` ou `unknown`.
    pub state: String,
    pub stalled: bool,
    pub transfer_id: Option<String>,
    /// Verdadeiro quando a identificação foi feita somente pelo id.
    pub via_id: bool,
    pub progress: Option<TorrentProgress>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TorrentProgress {
    pub bytes: Option<f64>,
    pub total: Option<f64>,
    pub speed: Option<f64>,
    pub seeders: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountEvidence {
    /// Ocupação desconhecida permanece `None`, nunca zero inferido.
    pub used: Option<u64>,
    pub max: Option<u64>,
}

/// O que a porta de evicção devolveu, na forma do contrato
/// (`adom_autofetch::v3::debrid::EvictOutcome`): o que SAIU e os motivos que a
/// guarda PROVOU para não remover.
///
/// `readded` (upload posterior ao nosso carimbo + margem) barra o delete e
/// precisa chegar ao passo: sem este mapa o painel não distingue "nada a
/// apagar" de "a conta mudou de dono".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EvictOutcome {
    /// Só os hashes que o serviço confirmou removidos.
    pub removed: Vec<String>,
    /// Motivo da guarda → quantos hashes ele barrou.
    pub vetoed: BTreeMap<String, usize>,
}

impl EvictOutcome {
    /// Nada saiu (`true` mesmo com vetos: veto não é remoção).
    pub fn is_empty(&self) -> bool {
        self.removed.is_empty()
    }
}

/// O mínimo que a porta precisa do `QueueCandidate` do worker: identidade
/// (hash) e a dica de obra para o RD. NADA de chave de API e nada de payload
/// persistido — o `QueueCandidate` completo (183 linhas de contrato de
/// serialização) continua sendo do worker e não é espelhado aqui.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PortCandidate {
    pub hash: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub dubbed: bool,
}

impl PortCandidate {
    pub fn new(hash: impl Into<String>) -> Self {
        Self {
            hash: hash.into(),
            ..Self::default()
        }
    }

    pub fn with_season_episode(mut self, season: Option<i64>, episode: Option<i64>) -> Self {
        self.season = season;
        self.episode = episode;
        self
    }

    pub fn with_dubbed(mut self, dubbed: bool) -> Self {
        self.dubbed = dubbed;
        self
    }
}

#[cfg(test)]
#[path = "autofetch_ports_contract_tests.rs"]
mod tests;
