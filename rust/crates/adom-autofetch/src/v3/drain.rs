//! Seleção do dreno sem rede e sem escrita: o trabalhador injeta as provas
//! de obsolescência, os bloqueios transitórios e a reserva da obra.

use super::QueueCandidate;

#[derive(Debug)]
pub struct DrainSelection<L> {
    pub next: Option<QueueCandidate>,
    pub remaining: Vec<QueueCandidate>,
    pub lease: Option<L>,
    /// Candidatos que permaneceram na fila porque a obra atingiu o teto.
    pub cap_deferred: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrainGates {
    pub search_key_present: bool,
    pub queue_enabled: bool,
    pub paused: bool,
    pub adapter_available: bool,
    pub budget_blocked: bool,
    pub rd_cooldown: bool,
    pub account_blocked: bool,
    pub refusals: usize,
    pub max_refusals: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrainBlock {
    Disabled,
    Paused,
    Empty,
    NoAdapter,
    Budget,
    RdCooldown,
    Account,
    Refusals,
}

#[derive(Debug)]
pub enum DrainNext<L> {
    /// A fila permanece intacta; não se testa nem remove obsoleto.
    Blocked {
        reason: DrainBlock,
        queue: Vec<QueueCandidate>,
    },
    Selected(Box<DrainSelection<L>>),
}

/// Aplica os portões ANTES de tocar na fila, e só então seleciona/reserva.
/// Os fatos são instantâneos: o executor deve tomar os locks de verdade antes
/// de iniciar rede e preservar a reserva ao tratar erros de persistência.
pub fn drain_next<L, E>(
    gates: &DrainGates,
    queue: Vec<QueueCandidate>,
    skip: impl FnMut(&QueueCandidate) -> Result<bool, E>,
    defer: impl FnMut(&QueueCandidate) -> Result<bool, E>,
    reserve: impl FnMut(&QueueCandidate) -> Result<Option<L>, E>,
) -> Result<DrainNext<L>, E> {
    let blocked = if !gates.search_key_present || !gates.queue_enabled {
        Some(DrainBlock::Disabled)
    } else if gates.paused {
        Some(DrainBlock::Paused)
    } else if queue.is_empty() {
        Some(DrainBlock::Empty)
    } else if !gates.adapter_available {
        Some(DrainBlock::NoAdapter)
    } else if gates.budget_blocked {
        Some(DrainBlock::Budget)
    } else if gates.rd_cooldown {
        Some(DrainBlock::RdCooldown)
    } else if gates.account_blocked {
        Some(DrainBlock::Account)
    } else if gates.refusals >= gates.max_refusals {
        Some(DrainBlock::Refusals)
    } else {
        None
    };
    if let Some(reason) = blocked {
        return Ok(DrainNext::Blocked { reason, queue });
    }
    select_drain_candidate(queue, skip, defer, reserve)
        .map(|value| DrainNext::Selected(Box::new(value)))
}

#[derive(Debug)]
pub enum DrainDecision<L> {
    Empty {
        remaining: Vec<QueueCandidate>,
    },
    InvalidSelection {
        queue: Vec<QueueCandidate>,
    },
    Requeue {
        queue: Vec<QueueCandidate>,
        lease: L,
        release_lock: bool,
        budget_backoff: bool,
    },
    /// O executor deve estabelecer hold ANTES da chamada de enqueue; marker
    /// e aceite da obra só podem ser gravados depois de sucesso confirmado.
    Start {
        candidate: Box<QueueCandidate>,
        remaining: Vec<QueueCandidate>,
        lease: L,
    },
}

/// Recebe o resultado real da aquisição do lock e do orçamento. A ordem da
/// fila e os efeitos de rollback espelham o dreno do Node.
pub fn finish_drain_selection<L>(
    selection: DrainSelection<L>,
    lock_acquired: bool,
    budget_acquired: bool,
) -> DrainDecision<L> {
    let Some(candidate) = selection.next else {
        return DrainDecision::Empty {
            remaining: selection.remaining,
        };
    };
    let Some(lease) = selection.lease else {
        let mut queue = vec![candidate];
        queue.extend(selection.remaining);
        return DrainDecision::InvalidSelection { queue };
    };
    if !lock_acquired || !budget_acquired {
        let mut queue = vec![candidate];
        queue.extend(selection.remaining);
        return DrainDecision::Requeue {
            queue,
            lease,
            release_lock: lock_acquired,
            budget_backoff: lock_acquired && !budget_acquired,
        };
    }
    DrainDecision::Start {
        candidate: Box::new(candidate),
        remaining: selection.remaining,
        lease,
    }
}

/// Mesmo laço de `takeDrainCandidate`: obsoletos saem; hold/sonda esperam;
/// cap fechado adia o candidato na frente e procura o próximo. O `skip` roda
/// também sobre elementos posteriores ao escolhido, como `takeNext` no Node.
/// Não persiste a fila; o dono precisa reservar e gravar com um único escritor.
pub fn select_drain_candidate<L, E>(
    mut queue: Vec<QueueCandidate>,
    mut skip: impl FnMut(&QueueCandidate) -> Result<bool, E>,
    mut defer: impl FnMut(&QueueCandidate) -> Result<bool, E>,
    mut reserve: impl FnMut(&QueueCandidate) -> Result<Option<L>, E>,
) -> Result<DrainSelection<L>, E> {
    let mut cap_deferred = Vec::new();
    let (next, mut remaining, lease) = loop {
        let mut first = None;
        let mut kept = Vec::new();
        for candidate in queue {
            if skip(&candidate)? {
                continue;
            }
            if first.is_none() && !defer(&candidate)? {
                first = Some(candidate);
            } else {
                kept.push(candidate);
            }
        }
        let Some(candidate) = first else {
            break (None, kept, None);
        };
        if let Some(lease) = reserve(&candidate)? {
            break (Some(candidate), kept, Some(lease));
        }
        cap_deferred.push(candidate);
        queue = kept;
    };
    let deferred_count = cap_deferred.len();
    cap_deferred.append(&mut remaining);
    Ok(DrainSelection {
        next,
        remaining: cap_deferred,
        lease,
        cap_deferred: deferred_count,
    })
}

#[cfg(test)]
#[path = "drain_decision_tests.rs"]
mod decision_tests;
