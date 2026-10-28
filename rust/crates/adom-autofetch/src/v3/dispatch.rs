//! Decisão pura do dispatch do Chupim (T3-L5).
//!
//! Mede todos os fatos antes de chamar esta função. Ela ordena os portões e
//! devolve efeitos em ordem; não faz I/O nem mantém locks/reservas.

use adom_core::{classify_enqueue, rollback_for, EnqueueGates, RollbackAction, SkipReason};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchInput {
    pub info_hash: String,
    pub gates: EnqueueGates,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchDecision {
    Enqueue {
        info_hash: String,
    },
    Skip {
        info_hash: String,
        reason: SkipReason,
        rollback: Vec<RollbackAction>,
    },
}

/// Classifica um candidato na mesma ordem de `enqueueAutofetch` TS.
pub fn dispatch(input: DispatchInput) -> DispatchDecision {
    match classify_enqueue(&input.gates) {
        None => DispatchDecision::Enqueue {
            info_hash: input.info_hash,
        },
        Some(reason) => DispatchDecision::Skip {
            info_hash: input.info_hash,
            reason,
            rollback: rollback_for(reason).to_vec(),
        },
    }
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod tests;
