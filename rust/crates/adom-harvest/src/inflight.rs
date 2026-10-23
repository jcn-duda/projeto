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
use crate::types::HarvestEntry;

/// Intenção de uma entrada (base ou coalescida em voo).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarvestIntent {
    pub reason: String,
    /// Precedência numérica do motivo (`reason_priority`: `next-episode` > `br-gap` > demais).
    pub rank: u8,
    pub br_probe: bool,
    pub priority_at: Option<i64>,
}

impl HarvestIntent {
    pub fn from_entry(entry: &HarvestEntry) -> Self {
        Self {
            reason: entry.reason.clone(),
            rank: reason_priority(&entry.reason),
            br_probe: entry.br_probe,
            priority_at: entry.priority_at,
        }
    }
}

/// Intenção completa (não-dirigida) mais forte coalescida no slot.
#[derive(Debug, Clone, PartialEq, Eq)]
struct FullIntent {
    reason: String,
    rank: u8,
    priority_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Slot {
    identity: String,
    // Intenção EFETIVA da execução (base + o que foi coalescido).
    reason: String,
    rank: u8,
    br_probe: bool,
    priority_at: Option<i64>,
    full: Option<FullIntent>,
}

/// O `full` que volta ao chamador (sem o `rank` interno).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingFull {
    pub reason: String,
    pub priority_at: Option<i64>,
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

    /// Abre o slot com a intenção da entrada que saiu da fila. O `full` nasce
    /// nulo de propósito: a cobertura da própria base quem decide é o caller.
    pub fn begin(&mut self, identity: &str, base: HarvestIntent) {
        self.current = Some(Slot {
            identity: identity.to_string(),
            reason: base.reason,
            rank: base.rank,
            br_probe: base.br_probe,
            priority_at: base.priority_at,
            full: None,
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
        // Só a intenção NÃO-dirigida exige cobertura completa; guarda a mais forte.
        if !intent.br_probe
            && slot
                .full
                .as_ref()
                .is_none_or(|full| intent.rank > full.rank)
        {
            slot.full = Some(FullIntent {
                reason: intent.reason.clone(),
                rank: intent.rank,
                priority_at: br_gap_priority(intent),
            });
        }
        true
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
            full: slot.full.as_ref().map(|full| PendingFull {
                reason: full.reason.clone(),
                priority_at: full.priority_at,
            }),
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
mod tests {
    use super::*;

    const ID: &str = "tt0111161::";

    fn intent(reason: &str, br_probe: bool) -> HarvestIntent {
        HarvestIntent {
            reason: reason.into(),
            rank: reason_priority(reason),
            br_probe,
            priority_at: (reason == "br-gap").then_some(7),
        }
    }

    #[test]
    fn so_a_mesma_obra_coalesce() {
        let mut inflight = HarvestInflight::new();
        inflight.begin(ID, intent("miss", false));
        assert!(inflight.is_inflight(ID));
        assert!(!inflight.is_inflight("tt0903747:1:2"));
        assert!(!inflight.coalesce("tt0903747:1:2", &intent("miss", false)));
        assert!(inflight.coalesce(ID, &intent("miss", false)));
    }

    #[test]
    fn rank_so_sobe_e_probe_e_aderente() {
        let mut inflight = HarvestInflight::new();
        inflight.begin(ID, intent("br-gap", false));
        // Motivo fraco: não rebaixa, mas marca o full.
        assert!(inflight.coalesce(ID, &intent("miss", false)));
        // Dirigido: não sobrescreve a intenção efetiva, só liga a flag.
        assert!(inflight.coalesce(ID, &intent("miss", true)));
        let pending = inflight.pending(ID).unwrap();
        assert_eq!(pending.reason, "br-gap");
        assert!(pending.br_probe);
        assert_eq!(pending.priority_at, Some(7));
        // Promoção forte sobe e herda a janela do br-gap.
        assert!(inflight.coalesce(ID, &intent("next-episode", false)));
        assert_eq!(inflight.pending(ID).unwrap().reason, "next-episode");
        assert_eq!(inflight.pending(ID).unwrap().priority_at, None);
    }

    #[test]
    fn full_ignora_dirigida_e_guarda_a_mais_forte() {
        let mut inflight = HarvestInflight::new();
        inflight.begin(ID, intent("miss", true));
        assert!(inflight.coalesce(ID, &intent("miss", true)));
        assert_eq!(inflight.pending(ID).unwrap().full, None);
        assert!(inflight.coalesce(ID, &intent("br-gap", false)));
        assert!(inflight.coalesce(ID, &intent("miss", false)));
        let full = inflight.pending(ID).unwrap().full.unwrap();
        assert_eq!(full.reason, "br-gap");
        assert_eq!(full.priority_at, Some(7));
    }

    #[test]
    fn end_so_derruba_a_identidade_da_vez() {
        let mut inflight = HarvestInflight::new();
        inflight.begin(ID, intent("miss", false));
        inflight.end("tt0903747:1:2");
        assert!(inflight.is_inflight(ID));
        inflight.end(ID);
        assert!(!inflight.is_inflight(ID));
        assert_eq!(inflight.pending(ID), None);
    }
}
