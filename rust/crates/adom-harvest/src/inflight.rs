//! Coalescing da colheita em voo — espelho de `src/providers/harvest-inflight.ts`.
//!
//! Um enqueue da MESMA obra que chega enquanto o colhedor já a colhe não cria
//! segunda entrada: a intenção funde no slot em voo. O tick é serial por
//! contrato, então um slot basta e a identidade é comparada em cada toque —
//! obra DIFERENTE nunca coalesce.
//!
//! Semântica herdada do TS, sem uniformizar:
//! - a promoção só SOBE (`rank` maior vence, nunca rebaixa);
//! - `br_probe` é OR-aderente (uma vez dirigida, a execução passa a probe);
//! - a intenção FULL (não-dirigida) é guardada à parte: um run dirigido cobre
//!   só o subset index-only∩pt-BR e NÃO satisfaz um pedido de colheita inteira.

use crate::reason::reason_priority;
use crate::types::{HarvestEntry, PendingFull};

/// Intenção de uma entrada (base ou coalescida em voo).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarvestIntent {
    pub reason: String,
    /// Precedência numérica do motivo (`reason_priority`: `next-episode` > `br-gap` > demais).
    pub rank: u8,
    pub br_probe: bool,
    pub priority_at: Option<i64>,
    pub full: Option<PendingFull>,
}

impl HarvestIntent {
    pub fn from_entry(entry: &HarvestEntry) -> Self {
        Self {
            reason: entry.reason.clone(),
            rank: reason_priority(&entry.reason),
            br_probe: entry.br_probe,
            priority_at: entry.priority_at,
            full: entry.pending_full(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Slot {
    identity: String,
    // Intenção EFETIVA da execução (base + o que foi coalescido).
    reason: String,
    rank: u8,
    br_probe: bool,
    priority_at: Option<i64>,
    full: Option<PendingFull>,
}

/// Intenção efetiva lida DEPOIS do drain; `None` quando a obra não está em voo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingIntent {
    pub reason: String,
    pub br_probe: bool,
    pub priority_at: Option<i64>,
    pub full: Option<PendingFull>,
}

/// Slot único da obra em voo.
#[derive(Debug, Default)]
pub struct HarvestInflight {
    current: Option<Slot>,
}

impl HarvestInflight {
    pub fn new() -> Self {
        Self::default()
    }

    /// Abre o slot com a intenção da entrada que saiu da fila, inclusive a
    /// obrigação FULL da base (sonda em voo não pode apagá-la).
    pub fn begin(&mut self, identity: &str, base: HarvestIntent) {
        self.current = Some(Slot {
            identity: identity.to_string(),
            reason: base.reason,
            rank: base.rank,
            br_probe: base.br_probe,
            priority_at: base.priority_at,
            full: base.full,
        });
    }

    /// Encerra só se a identidade casa (obra diferente não derruba o slot).
    pub fn end(&mut self, identity: &str) {
        if self.is_inflight(identity) {
            self.current = None;
        }
    }

    pub fn is_inflight(&self, identity: &str) -> bool {
        self.current
            .as_ref()
            .is_some_and(|slot| slot.identity == identity)
    }

    /// `true` quando casou com a obra em voo — o chamador NÃO cria entrada nova.
    pub fn coalesce(&mut self, identity: &str, intent: &HarvestIntent) -> bool {
        let Some(slot) = self
            .current
            .as_mut()
            .filter(|slot| slot.identity == identity)
        else {
            return false;
        };
        if intent.br_probe {
            slot.br_probe = true;
        }
        if intent.rank > slot.rank {
            slot.reason = intent.reason.clone();
            slot.rank = intent.rank;
            // `priority_at` pertence à janela do br-gap; fora dela não se
            // inventa instante (o campo fica ausente).
            slot.priority_at = br_gap_priority(intent);
        }
        slot.full = PendingFull::strongest(slot.full.clone(), intent.full.clone());
        true
    }

    /// Há slot em voo desta obra (IMDb), qualquer S/E.
    pub fn pending_for_imdb(&self, imdb: &str) -> Option<PendingIntent> {
        let slot = self
            .current
            .as_ref()
            .filter(|slot| slot.identity.split(':').next() == Some(imdb))?;
        Some(PendingIntent {
            reason: slot.reason.clone(),
            br_probe: slot.br_probe,
            priority_at: slot.priority_at,
            full: slot.full.clone(),
        })
    }

    /// Não limpa o slot — quem encerra é o [`end`](Self::end).
    pub fn pending(&self, identity: &str) -> Option<PendingIntent> {
        let slot = self
            .current
            .as_ref()
            .filter(|slot| slot.identity == identity)?;
        Some(PendingIntent {
            reason: slot.reason.clone(),
            br_probe: slot.br_probe,
            priority_at: slot.priority_at,
            full: slot.full.clone(),
        })
    }

    /// Limpa o slot volátil — simula restart nos testes.
    pub fn clear(&mut self) {
        self.current = None;
    }
}

fn br_gap_priority(intent: &HarvestIntent) -> Option<i64> {
    if intent.reason == "br-gap" {
        intent.priority_at
    } else {
        None
    }
}

#[cfg(test)]
#[path = "inflight_tests.rs"]
mod tests;
