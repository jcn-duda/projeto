//! Seleção pura de fallbacks removíveis após ready BR comprovado + o executor
//! do passo de evicção.
//!
//! A decisão (`eligible_evictions`) é um conjunto fechado de provas: BR ready
//! na obra, pool `any`/`seeds`, marker da MESMA obra, posse durável, sem hold,
//! sem `adprot`, sem `overflow` e idade mínima. O executor ([`execute`]) só
//! obedece ao plano: **nunca** escolhe hash e **nunca** apaga por hash — a única
//! âncora aceita é o `transfer_id` (nenhum dos cinco serviços tem delete por
//! hash: a porta responde `unsupported: evict`,
//! `adom-debrid/src/autofetch_ports_inner.rs:210`).

use super::debrid::AutofetchDebrid;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvictCandidate {
    pub hash: String,
    pub pool: String,
    pub overflow: bool,
    pub marker_matches_work: bool,
    pub owned: bool,
    pub held: bool,
    pub protected: bool,
    pub accepted_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvictInput {
    pub current_ready_is_br: bool,
    pub work_has_prior_br_ready: bool,
    pub now: i64,
    pub min_age_ms: i64,
    pub candidates: Vec<EvictCandidate>,
}

/// Conserva a ordem do registro da obra; overflow nunca é removível.
pub fn eligible_evictions(input: &EvictInput) -> Vec<String> {
    if !input.current_ready_is_br && !input.work_has_prior_br_ready {
        return Vec::new();
    }
    let min_age = input.min_age_ms.max(0);
    let mut seen = std::collections::HashSet::new();
    input
        .candidates
        .iter()
        .filter_map(|entry| {
            let hash = entry.hash.to_lowercase();
            let age = input.now.saturating_sub(entry.accepted_at);
            let eligible = !hash.is_empty()
                && seen.insert(hash.clone())
                && matches!(entry.pool.as_str(), "any" | "seeds")
                && !entry.overflow
                && entry.marker_matches_work
                && entry.owned
                && !entry.held
                && !entry.protected
                && entry.accepted_at > 0
                && age >= min_age;
            eligible.then_some(hash)
        })
        .collect()
}

/// Por que o hash NÃO saiu. Os rótulos são a métrica
/// `autofetch.evict.skipped.<motivo>` do TS (`autofetch-evict.ts:247`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvictSkip {
    /// Sem prova de BR ready na obra (nem atual, nem anterior).
    NoBrProof,
    EmptyHash,
    /// Pool `br`: o alvo da evicção é o fallback, nunca o dublado.
    PoolBr,
    Overflow,
    /// Marker de outra obra (ou legado `1`/`{id}`).
    OtherWork,
    NoOwnership,
    Held,
    /// Retenção BR: nome/`adprot` com sinal brasileiro.
    BrRetained,
    Protected,
    NoAcceptedAt,
    TooYoung,
    /// Veto final (`may_delete` do passo).
    Veto,
    Duplicate,
    /// Teto da passagem (`max_per_run`/piso de ocupação).
    OverLimit,
    /// Sem id de transferência: a porta não apaga por hash.
    NoTransferId,
    /// Sem nome autoritativo: sem blindagem BR não há delete.
    NoName,
    /// Passagem parada por erro anterior.
    NotAttempted,
}

impl EvictSkip {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoBrProof => "no-br-proof",
            Self::EmptyHash => "empty-hash",
            Self::PoolBr => "pool-br",
            Self::Overflow => "overflow",
            Self::OtherWork => "other-work",
            Self::NoOwnership => "no-ownership",
            Self::Held => "held",
            Self::BrRetained => "br-retained",
            Self::Protected => "protected",
            Self::NoAcceptedAt => "no-accepted-at",
            Self::TooYoung => "too-young",
            Self::Veto => "veto",
            Self::Duplicate => "duplicate",
            Self::OverLimit => "over-limit",
            Self::NoTransferId => "no-transfer-id",
            Self::NoName => "no-name",
            Self::NotAttempted => "not-attempted",
        }
    }
}

/// Uma linha do plano: ou a remoção PROVADA, ou o pulo com motivo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvictAction {
    Remove {
        hash: String,
        transfer_id: String,
        name: String,
    },
    Skip {
        hash: String,
        reason: EvictSkip,
    },
}

impl EvictAction {
    pub fn hash(&self) -> &str {
        match self {
            Self::Remove { hash, .. } | Self::Skip { hash, .. } => hash,
        }
    }

    pub fn is_remove(&self) -> bool {
        matches!(self, Self::Remove { .. })
    }
}

/// Taxonomia da parada. O prefixo vem de `PortError::kind()`
/// (`adom-server/src/autofetch/ports.rs:227`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvictStop {
    /// Escrita anterior de resultado incerto: não se insiste.
    Quarantined,
    Cooldown,
    RateLimit,
    /// Qualquer outra recusa (`unsupported`, `auth`, `quota`, `blocked`, …).
    Other(String),
}

impl EvictStop {
    pub fn classify(message: &str) -> Self {
        let kind = message.split(':').next().unwrap_or("").trim();
        match kind {
            "quarantined" => Self::Quarantined,
            "cooldown" => Self::Cooldown,
            "rate_limit" => Self::RateLimit,
            kind => Self::Other(kind.to_string()),
        }
    }

    /// `true` nas três famílias em que insistir piora.
    pub fn is_throttle(&self) -> bool {
        matches!(self, Self::Quarantined | Self::Cooldown | Self::RateLimit)
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Quarantined => "quarantined",
            Self::Cooldown => "cooldown",
            Self::RateLimit => "rate_limit",
            Self::Other(kind) => kind,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evicted {
    pub hash: String,
    pub transfer_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvictFailure {
    pub hash: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvictSkipped {
    pub hash: String,
    pub reason: EvictSkip,
}

/// O que a passagem fez. `stop` preenchido = o resto não foi tentado.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EvictReport {
    pub removed: Vec<Evicted>,
    pub failed: Vec<EvictFailure>,
    pub skipped: Vec<EvictSkipped>,
    pub stop: Option<EvictStop>,
}

impl EvictReport {
    /// `(removed, failed, skipped)` — a soma é o tamanho do plano.
    pub fn counts(&self) -> (usize, usize, usize) {
        (self.removed.len(), self.failed.len(), self.skipped.len())
    }

    /// Hashes que SAÍRAM de verdade: só esses perdem marker e vaga da obra.
    pub fn removed_hashes(&self) -> Vec<String> {
        self.removed.iter().map(|item| item.hash.clone()).collect()
    }
}

/// Executa o plano: `remove(transfer_id)` item a item, parando no primeiro
/// erro. Nunca lança — o erro vira `failed` + `stop` e o resto do plano é
/// contado como `not-attempted` (fail-closed: depois de uma recusa o estado da
/// conta é desconhecido, e insistir é o lado destrutivo).
pub async fn execute(
    io: &dyn AutofetchDebrid<Error = String>,
    actions: &[EvictAction],
) -> EvictReport {
    let mut report = EvictReport::default();
    let mut stopped = false;
    for action in actions {
        let (hash, transfer_id, name) = match action {
            EvictAction::Remove {
                hash,
                transfer_id,
                name,
            } => (hash, transfer_id, name),
            EvictAction::Skip { hash, reason } => {
                report.skipped.push(EvictSkipped {
                    hash: hash.clone(),
                    reason: *reason,
                });
                continue;
            }
        };
        if stopped {
            report.skipped.push(EvictSkipped {
                hash: hash.clone(),
                reason: EvictSkip::NotAttempted,
            });
            continue;
        }
        match io.remove(transfer_id).await {
            Ok(true) => report.removed.push(Evicted {
                hash: hash.clone(),
                transfer_id: transfer_id.clone(),
                name: name.clone(),
            }),
            // Recusa sem erro: o serviço respondeu "não removi" (RD sem o hash
            // do id, por exemplo). Não para a passagem — não houve incerteza.
            Ok(false) => report.failed.push(EvictFailure {
                hash: hash.clone(),
                reason: "declined".to_string(),
            }),
            Err(message) => {
                report.failed.push(EvictFailure {
                    hash: hash.clone(),
                    reason: message.clone(),
                });
                report.stop = Some(EvictStop::classify(&message));
                stopped = true;
            }
        }
    }
    report
}

#[cfg(test)]
#[path = "evict_tests.rs"]
mod tests;
