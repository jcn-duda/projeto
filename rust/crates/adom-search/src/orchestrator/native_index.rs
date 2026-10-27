//! Leitura NATIVA do índice/banco para a via rápida do `/stream` (R4).
//!
//! Substituiu a rota Node de leitura do índice (removida no R4): lookup do
//! `idx:v14`, via
//! instantânea do `magnets.db`, itens da conta e o follow-up do índice.
//! A ORDEM e as MARCAS são as do TS:
//!
//! - instantânea → `fromFallback` (📦/~N) nos itens do acervo;
//! - índice → `fromSnapshot` (a foto também exibe 📦 até a promoção tardia);
//! - conta → `fromAccount`;
//! - resposta instantânea = acervo + índice + conta; resposta do índice coberto
//!   = índice (SEM selo — o `idxReleasesToRaw` do TS não marca) + conta.
//!
//! O follow-up roda em TODA busca, como na rota do Node, e é emitido por
//! `/internal/search/effects` (fire-and-forget).

use adom_core::{idx_pool_covered, PoolCoverageItem};

use crate::raw_item::RawItem;

use super::finish::SearchInput;
use super::index_effects::{effect_entries, follow_up_plan, FollowUpPlan};
use super::index_metrics as metrics;
use super::index_source::{allowed_source_indexer, obra_targets, IndexedReleaseWire};
use super::meta::SearchMeta;
use super::native_index_wire::{attach_bank_dn, release_to_coverage, release_to_raw};
use super::respond::now_ms;
use super::tail::EffectsBatch;
use super::Orchestrator;

/// Resultado da leitura nativa. Os itens das três fontes ficam SEPARADOS para a
/// via rápida escolher as marcas de cada conjunto.
#[derive(Clone, Debug, Default)]
pub(super) struct NativeIndexOutcome {
    pub indexed: Vec<IndexedReleaseWire>,
    pub is_partial: bool,
    pub index_covered: bool,
    pub instant_eligible: bool,
    pub index_items: Vec<RawItem>,
    pub instant_items: Vec<RawItem>,
    pub account_items: Vec<RawItem>,
    pub follow_up: FollowUpPlan,
}

impl NativeIndexOutcome {
    fn has_any(&self) -> bool {
        self.instant_eligible || self.index_covered
    }
}

impl Orchestrator {
    /// Via rápida nativa. `None` = nem instantânea nem índice coberto (a coleta
    /// ao vivo segue); o follow-up ainda é emitido, como no Node.
    pub(super) async fn native_fast_path(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
    ) -> Option<super::fast_path::FastPath> {
        let outcome = self.native_index_scan(input, meta).await;
        self.emit_index_follow_up(input, meta, &outcome).await;
        if outcome.instant_eligible {
            let mut items: Vec<RawItem> = outcome.instant_items.clone();
            items.extend(outcome.index_items.iter().cloned());
            items.extend(outcome.account_items.iter().cloned());
            return Some(super::fast_path::FastPath {
                instant: true,
                items,
            });
        }
        if outcome.index_covered {
            // Via do índice NÃO-instantânea: o `idxReleasesToRaw` do TS não põe
            // marca nenhuma, então `fromSnapshot` é NEUTRALIZADO.
            let mut items: Vec<RawItem> = outcome
                .index_items
                .iter()
                .cloned()
                .map(|mut item| {
                    item.from_snapshot = false;
                    item
                })
                .collect();
            items.extend(outcome.account_items.iter().cloned());
            return Some(super::fast_path::FastPath {
                instant: false,
                items,
            });
        }
        let _ = outcome.has_any();
        None
    }

    /// Follow-up: decisão do índice + POST fire-and-forget dos efeitos.
    async fn emit_index_follow_up(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        outcome: &NativeIndexOutcome,
    ) {
        if !self.config.release_index_enabled {
            return;
        }
        let effects = effect_entries(
            &outcome.follow_up,
            &meta.imdb_id,
            &input.kind,
            meta.season,
            meta.episode,
        );
        if effects.is_empty() {
            return;
        }
        metrics::global_metrics().inc(metrics::EFFECTS, effects.len() as u64);
        let tail = self.tail.clone();
        let encoded = crate::request::encoded_for_internal(input.encoded.as_deref());
        tokio::spawn(async move {
            if let Err(err) = tail.effects(EffectsBatch { encoded, effects }).await {
                eprintln!("[search] effects do índice falharam: {err}");
            }
        });
    }

    /// Leitura + decisão (sem emitir nada).
    pub(super) async fn native_index_scan(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
    ) -> NativeIndexOutcome {
        let now = now_ms();
        let mut outcome = NativeIndexOutcome::default();
        let enabled = self.config.release_index_enabled && self.config.release_index_ttl > 0;
        let mut covered = false;
        let mut autofetch_seeded = false;
        if let Some(index) = self.index.as_ref() {
            if enabled {
                metrics::global_metrics().inc(metrics::LOOKUP, 1);
                let extracted = index.lookup(&meta.imdb_id, meta.season, meta.episode, now);
                outcome.indexed = extracted
                    .into_iter()
                    .filter(|release| {
                        release.source.as_deref() == Some("autofetch")
                            || allowed_source_indexer(
                                &release.indexer,
                                &input.options,
                                &self.config.index_only_indexers,
                                &self.config.selected_indexers,
                            )
                    })
                    .collect();
                outcome.is_partial = !outcome.indexed.is_empty()
                    && index.is_partial(&meta.imdb_id, meta.season, meta.episode, now);
                let coverage_items: Vec<PoolCoverageItem> =
                    outcome.indexed.iter().map(release_to_coverage).collect();
                covered = !outcome.indexed.is_empty()
                    && !outcome.is_partial
                    && idx_pool_covered(
                        &coverage_items,
                        meta.season,
                        meta.episode,
                        self.config.auto_fetch_min_seeders,
                    )
                    .covered;
                autofetch_seeded = outcome
                    .indexed
                    .iter()
                    .any(|release| release.source.as_deref() == Some("autofetch"));
                outcome.index_covered = !outcome.is_partial && (covered || autofetch_seeded);
                outcome.index_items = outcome
                    .indexed
                    .iter()
                    .map(|release| release_to_raw(release, true))
                    .collect();
                if let Some(bank) = self.bank.as_ref() {
                    attach_bank_dn(&mut outcome.index_items, bank.as_ref());
                }
            }
        } else {
            metrics::global_metrics().inc(metrics::SOURCE_MISSING, 1);
            eprintln!("[search] idx:v14 indisponível; seguindo sem índice nativo");
        }

        // Via instantânea (banco), antes do fast-path do índice. Independe do
        // `idx:v14`: só o `magnets.db` aberto já responde a via rápida.
        let indexed_snapshot = outcome.indexed.clone();
        self.fill_instant(
            &input.options,
            &input.kind,
            meta,
            now,
            &indexed_snapshot,
            &mut outcome,
        );

        // Follow-up: o mesmo critério da rota Node, inclusive para obra fora do
        // índice (miss/gap). O acervo só é lido quando o índice não prova BR.
        let bank = self.bank.clone();
        let targets = obra_targets(&input.kind, meta.season, meta.episode);
        outcome.follow_up = follow_up_plan(
            &outcome.indexed,
            outcome.is_partial,
            covered,
            autofetch_seeded,
            !self.config.index_only_indexers.is_empty(),
            || {
                bank.as_ref()
                    .is_some_and(|bank| bank.has_br_row(&meta.imdb_id, &targets))
            },
        );
        self.count_index_metrics(&outcome, covered);

        outcome.account_items = self.native_account_items(input, meta).await;
        outcome
    }

    fn count_index_metrics(&self, outcome: &NativeIndexOutcome, covered: bool) {
        let m = metrics::global_metrics();
        let plan = &outcome.follow_up;
        if plan.miss {
            m.inc(metrics::MISS, 1);
        }
        if plan.hit {
            m.inc(metrics::HIT, 1);
        }
        if plan.partial {
            m.inc(metrics::PARTIAL, 1);
        }
        if plan.gap {
            m.inc(metrics::GAP, 1);
        }
        if plan.served {
            m.inc(metrics::BR_GAP_SERVED, 1);
        }
        if plan.br_gap {
            m.inc(metrics::BR_GAP, 1);
            if plan.upgrade {
                m.inc(metrics::BR_GAP_UPGRADE, 1);
            }
            if plan.bank_evidence {
                m.inc(metrics::BR_GAP_BANK_EVIDENCE, 1);
            }
            if plan.no_evidence {
                m.inc(metrics::BR_GAP_NO_EVIDENCE, 1);
            }
        }
        if outcome.index_covered {
            m.inc(metrics::SERVED, outcome.index_items.len() as u64);
        }
        let _ = covered;
    }
}

/// Um `FollowUpKind` isolado (diagnóstico/teste).
#[cfg(test)]
pub(super) fn follow_up_count(
    plan: &FollowUpPlan,
    kind: super::index_effects::FollowUpKind,
) -> usize {
    plan.actions
        .iter()
        .filter(|action| **action == kind)
        .count()
}

#[cfg(test)]
#[path = "native_index_tests.rs"]
mod tests;
