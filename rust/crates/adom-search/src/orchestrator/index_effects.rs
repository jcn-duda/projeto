//! Follow-up do índice (`enqueueIndexFollowUp` de `search-index-path.ts`) e os
//! efeitos de fio que ele emite.
//!
//! Quando a leitura do índice migra para o Rust, a EMISSÃO destes efeitos sai
//! do Node junto com ela: `POST /internal/search/effects` é o transporte (202,
//! fire-and-forget) e o handler continua sendo o dono das filas
//! (`harvestQueue`, `requestBrProbe`). Este módulo só DECIDE e MONTA o payload;
//! as regras puras de BR-gap vivem em `adom_core::br_gap`.
//!
//! A ordem dos motivos é a do TS: `miss` (índice vazio), `gap` (não cobre ou é
//! parcial) e a sonda dirigida (`br_probe`, com `mode` upgrade/evidence) quando
//! cobre mas falta BR dublado — com o portão de plausibilidade: sem evidência
//! BR no índice nem no acervo, a sonda não é elegível e a colheita regular de
//! gap já cobre a descoberta.

use serde_json::{json, Value};

use crate::internal_types::EffectEntry;
use adom_core::{has_br_dubbed, has_br_evidence, should_br_gap, BrGapRelease};

use super::index_source::IndexedReleaseWire;

/// Efeito de follow-up decidido pelo índice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowUpKind {
    /// Obras que o índice/colhedor precisa descobrir.
    HarvesterMiss,
    HarvesterGap,
    HarvesterBrGap,
    /// Sonda dirigida (index-only BR) — pedido explícito, não fila genérica.
    BrProbeEvidence,
    BrProbeUpgrade,
}

impl FollowUpKind {
    pub fn reason(self) -> Option<&'static str> {
        match self {
            Self::HarvesterMiss => Some("miss"),
            Self::HarvesterGap => Some("gap"),
            Self::HarvesterBrGap => Some("br-gap"),
            Self::BrProbeEvidence | Self::BrProbeUpgrade => None,
        }
    }

    pub fn probe_mode(self) -> Option<&'static str> {
        match self {
            Self::BrProbeEvidence => Some("evidence"),
            Self::BrProbeUpgrade => Some("upgrade"),
            _ => None,
        }
    }

    /// Forma comparável com o `effects` que a rota Node devolve.
    pub fn as_json(self) -> Value {
        match self.reason() {
            Some(reason) => json!({"kind": "harvester_enqueue", "reason": reason}),
            None => json!({"kind": "br_probe", "mode": self.probe_mode().unwrap_or("evidence")}),
        }
    }
}

/// Decisão + o que o caller conta nas métricas nativas.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FollowUpPlan {
    pub actions: Vec<FollowUpKind>,
    pub miss: bool,
    pub hit: bool,
    pub partial: bool,
    pub gap: bool,
    pub autofetch_seed: bool,
    pub br_gap: bool,
    pub upgrade: bool,
    pub bank_evidence: bool,
    pub no_evidence: bool,
    pub served: bool,
}

/// `BR dublado comprovado` no índice — vira o modo `upgrade` da sonda.
fn releases(indexed: &[IndexedReleaseWire]) -> Vec<BrGapRelease<'_>> {
    indexed
        .iter()
        .map(|release| BrGapRelease {
            source: release.source.as_deref(),
            is_br: release.is_br,
            dubbed: release.dubbed,
            lied: release.lied,
            quality: release.quality.as_str(),
        })
        .collect()
}

/// Espelho de `enqueueIndexFollowUp` com `countMetrics:false` separado do
/// chamador. `bank_evidence` é LAZY: o SQLite do acervo só é lido quando o
/// índice não prova BR (curto-circuito do TS).
pub fn follow_up_plan(
    indexed: &[IndexedReleaseWire],
    partial: bool,
    covered: bool,
    autofetch_seeded: bool,
    index_only_configured: bool,
    bank_evidence: impl FnOnce() -> bool,
) -> FollowUpPlan {
    let mut plan = FollowUpPlan::default();
    if indexed.is_empty() {
        plan.miss = true;
        plan.actions.push(FollowUpKind::HarvesterMiss);
        return plan;
    }
    if !partial && (covered || autofetch_seeded) {
        if covered {
            plan.hit = true;
        } else {
            // O Chupim submeter a release não transforma visibilidade em
            // cobertura: a coleta continua no tail.
            plan.autofetch_seed = true;
            plan.gap = true;
            plan.actions.push(FollowUpKind::HarvesterGap);
        }
        let gap_releases = releases(indexed);
        if covered && should_br_gap(&gap_releases, index_only_configured) {
            plan.br_gap = true;
            plan.upgrade = has_br_dubbed(&gap_releases);
            let index_evidence = has_br_evidence(&gap_releases);
            let has_bank = if index_evidence {
                false
            } else {
                bank_evidence()
            };
            plan.bank_evidence = has_bank;
            if index_evidence || has_bank {
                plan.actions.push(if plan.upgrade {
                    FollowUpKind::BrProbeUpgrade
                } else {
                    FollowUpKind::BrProbeEvidence
                });
            } else {
                plan.no_evidence = true;
            }
        } else if covered && has_br_dubbed(&gap_releases) {
            plan.served = true;
        }
        return plan;
    }
    if partial {
        plan.partial = true;
    }
    plan.gap = true;
    plan.actions.push(FollowUpKind::HarvesterGap);
    plan
}

/// Payloads de fio do plano. `None` = não há o que emitir.
pub fn effect_entries(
    plan: &FollowUpPlan,
    imdb_id: &str,
    type_: &str,
    season: Option<i64>,
    episode: Option<i64>,
) -> Vec<EffectEntry> {
    plan.actions
        .iter()
        .map(|action| {
            let payload = match action.reason() {
                Some(reason) => json!({
                    "imdbId": imdb_id,
                    "type": type_,
                    "season": season,
                    "episode": episode,
                    "reason": reason,
                }),
                None => json!({
                    "imdbId": imdb_id,
                    "type": type_,
                    "season": season,
                    "episode": episode,
                    "mode": action.probe_mode().unwrap_or("evidence"),
                }),
            };
            EffectEntry {
                kind: match action {
                    FollowUpKind::HarvesterMiss
                    | FollowUpKind::HarvesterGap
                    | FollowUpKind::HarvesterBrGap => "harvester_enqueue".to_string(),
                    _ => "br_probe".to_string(),
                },
                payload: payload.as_object().cloned().unwrap_or_default(),
            }
        })
        .collect()
}

#[cfg(test)]
#[path = "index_effects_tests.rs"]
mod tests;
