//! Fatos de UMA rodada e o despacho das quatro decisões puras.
//!
//! Separado do núcleo (`al_sweeps.rs`) para o arquivo caber no teto de 400
//! linhas. Nada aqui fala com a conta: só transforma a porta [`FactSource`] nos
//! conjuntos que o núcleo (`adom_debrid::alldebrid_sweeps`) consome.

use std::collections::{BTreeMap, HashMap, HashSet};

use adom_debrid::alldebrid_sweeps::{
    plan_reconcile, plan_revalidate, plan_sweep_dead, plan_sweep_undubbed, MagnetRow, SweepConfig,
    SweepFacts, SweepKind, SweepOutcome, SweepPlan,
};

use super::FactSource;

/// Conjuntos vivos de uma rodada (empresta a view para o núcleo).
#[derive(Default)]
pub(crate) struct Facts {
    pub(crate) known_before: Option<HashSet<String>>,
    pub(crate) held: HashSet<String>,
    pub(crate) retained: HashSet<String>,
    owned_at: HashMap<String, i64>,
    marked: HashSet<String>,
    consulted: HashSet<String>,
    suppressed: HashSet<String>,
}

impl Facts {
    pub(crate) fn view(&self, now_ms: i64) -> SweepFacts<'_> {
        SweepFacts {
            known_before: self.known_before.as_ref(),
            held: &self.held,
            retained: &self.retained,
            owned_at: &self.owned_at,
            marked: &self.marked,
            consulted: &self.consulted,
            suppressed: &self.suppressed,
            now_ms,
        }
    }
}

/// `consulted` é fato de BUSCA (o upload da checagem): uma varredura de fundo
/// não é busca, e vazio o reconcile não remove re-add (`no_ownership`) — nunca
/// "libera" um hash por omissão de fato. `suppressed` É montado da fila `sup:`
/// (fase 1 do wiring): sem fila o revalidate não condena ninguém
/// (`not_suppressed`), com fila ele reavalia só o que a represa guarda.
pub(crate) fn gather(facts: &dyn FactSource, rows: &[MagnetRow]) -> Facts {
    let mut out = Facts {
        known_before: facts.known_before(),
        marked: facts.marked(),
        suppressed: facts.suppressed(),
        ..Facts::default()
    };
    for row in rows {
        let hash = row.normalized_hash();
        if hash.is_empty() {
            continue;
        }
        if facts.held(&hash) {
            out.held.insert(hash.clone());
        }
        if facts.retained(&hash) {
            out.retained.insert(hash.clone());
        }
        if let Some(at) = facts.owned_at(&hash) {
            out.owned_at.insert(hash, at);
        }
    }
    out
}

pub(crate) fn config_of(kind: SweepKind) -> SweepConfig {
    match kind {
        SweepKind::Dead => SweepConfig::dead(),
        SweepKind::Undubbed => SweepConfig::undubbed(),
        SweepKind::Reconcile => SweepConfig::reconcile(),
        SweepKind::Revalidate => SweepConfig::revalidate(),
    }
}

pub(crate) fn plan_of(
    kind: SweepKind,
    rows: &[MagnetRow],
    facts: &SweepFacts<'_>,
    config: &SweepConfig,
) -> SweepPlan {
    match kind {
        SweepKind::Dead => plan_sweep_dead(rows, facts, config),
        SweepKind::Undubbed => plan_sweep_undubbed(rows, facts, config),
        SweepKind::Reconcile => plan_reconcile(rows, facts, config),
        SweepKind::Revalidate => plan_revalidate(rows, facts, config),
    }
}

/// Resultado de uma rodada. `missing` lista os tipos que não tiveram plano (a
/// conta não respondeu): `delete` zero, sempre.
#[derive(Debug, Default)]
pub(crate) struct TickReport {
    pub(crate) outcomes: Vec<SweepOutcome>,
    pub(crate) missing: Vec<SweepKind>,
    /// Outra rodada estava em voo (anti-reentrada).
    pub(crate) reentered: bool,
    /// Nenhum tipo estava no intervalo.
    pub(crate) not_due: bool,
}

impl TickReport {
    pub(crate) fn planned(&self) -> usize {
        self.outcomes.iter().map(|outcome| outcome.planned).sum()
    }

    pub(crate) fn removed(&self) -> usize {
        self.outcomes
            .iter()
            .map(|outcome| outcome.removed.len())
            .sum()
    }

    pub(crate) fn calls(&self) -> usize {
        self.outcomes.iter().map(|outcome| outcome.calls).sum()
    }
}

/// Plano vazio do tipo: sem listagem não há linha nem motivo por hash.
pub(crate) fn missing_outcome(kind: SweepKind) -> SweepOutcome {
    SweepOutcome {
        kind,
        applied: false,
        planned: 0,
        removed: Vec::new(),
        failed: Vec::new(),
        blocked: Vec::new(),
        stopped: None,
        calls: 0,
        skip: BTreeMap::new(),
    }
}
