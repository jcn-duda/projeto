//! Fila tardia: promoção, refresh de debrid, varredura pt-BR e index-write.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;

use adom_core::{late_promotion_decision, LateAction, LateFacts};

use crate::cache::{has_playable_stream, to_cacheable_entry};
use crate::latest_writer::LatestWriter;
use crate::raw_item::RawItem;
use crate::request::encoded_for_internal;

use super::collect;
use super::finish::{release_entry, FinishValue, SearchInput};
use super::index_metrics as metrics;
use super::index_source::BankFilterCtx;
use super::live_state::{live_state_snapshot, LiveBatchState, SharedLiveState};
use super::meta::SearchMeta;
use super::respond::{as_ms, now_ms};
use super::tail::{EffectsBatch, IndexBatch, TailJob, TailPlan};
use super::Orchestrator;

impl Orchestrator {
    pub(super) fn tail_plan(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        first: &FinishValue,
        partial: bool,
    ) -> TailPlan {
        let mut jobs = Vec::new();
        if !first.filtered.is_empty() || !first.entered.is_empty() {
            jobs.push(TailJob::IndexEnrich {
                releases: vec![release_entry(meta, &first.entered, &first.filtered)],
            });
        }
        if first.needs_debrid_refresh {
            jobs.push(TailJob::DebridRefresh);
        }
        if partial && self.config.sweep_enabled && meta.sweep_query.is_some() {
            // Total PRÓPRIO da fonte BR como prazo do passe (sem cliente).
            jobs.push(TailJob::PtSweep {
                deadline_at: self.config.budgets.br_deadline(None, input.now_ms),
            });
        }
        TailPlan {
            encoded: encoded_for_internal(input.encoded.as_deref()),
            meta: meta.clone(),
            jobs,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) async fn run_tail(
        &self,
        mut input: SearchInput,
        meta: SearchMeta,
        first: FinishValue,
        partial_items: Vec<RawItem>,
        _partial: bool,
        plan: TailPlan,
        completion: Option<tokio::task::JoinHandle<Vec<RawItem>>>,
        live_state: Option<SharedLiveState>,
        writer: Arc<LatestWriter>,
    ) {
        // O cliente já recebeu (ou o prazo da resposta venceu): o deadline do
        // request NÃO governa mais a build tardia. Sem isto a reserva 📦 veria
        // o prazo vencido e não consultaria o banco justamente no tail, onde o
        // estado vivo está completo. O teto curto de `with_fallback` vale.
        input.deadline_at = None;
        let phase = writer.phase();
        // Mudou = cresceu OU trocou marca: a via rápida tira 📦 sem acrescentar
        // item, e a promoção "sem novidade" gravaria a lista antiga com o selo
        // e TTL cheio (o mesmo cuidado do `clearInstantSnapshots` do TS).
        let (mut full, changed) = match completion {
            Some(handle) => {
                let full = handle.await.unwrap_or_else(|_| partial_items.clone());
                let changed = full != partial_items;
                (full, changed)
            }
            None => (partial_items, false),
        };
        // Estado FINAL pós-completion: as tasks que alimentam o compartilhado
        // já assentaram (o `completion` acima as aguardou). É o mesmo estado
        // que o Node passa ao `latePromoter` — nunca `None` por omissão.
        let live_final = live_state.as_ref().and_then(live_state_snapshot);
        let mut last = first;
        if changed {
            // Fontes lentas chegaram (ou marcas saíram): reconstrói com o lote
            // COMPLETO e regrava (fase atual, revisão mais nova). A reserva 📦
            // é reinjetada com o estado vivo FINAL, como em toda build.
            let build_items = self
                .with_fallback(&input, &meta, full.clone(), live_final.as_ref())
                .await;
            last = self.finish(&input, &meta, &writer, phase, &build_items, false, None);
        } else {
            // Sem novidade: a entrada parcial é PROMOVIDA pelo `search_finish`
            // (mesmas regras do late promoter do TS).
            self.promote_late(&input, live_final.as_ref());
        }

        for job in plan.jobs {
            match job {
                TailJob::IndexEnrich { .. } => {
                    // Entrega no FIM, com o funil da passada mais nova.
                    continue;
                }
                TailJob::DebridRefresh => {
                    if !last.needs_debrid_refresh {
                        continue;
                    }
                    if self.debrid_refresh_satisfied(&input) {
                        continue;
                    }
                    let build_items = self
                        .with_fallback(&input, &meta, full.clone(), live_final.as_ref())
                        .await;
                    last = self.finish(&input, &meta, &writer, phase, &build_items, false, None);
                }
                TailJob::PtSweep { deadline_at } => {
                    let selection = collect::RequestSelection::from_options(
                        &input.options,
                        self.config.mico_default,
                    );
                    let Some(job) = collect::sweep_job(
                        &self.config,
                        &meta,
                        &input.kind,
                        input.encoded.as_deref(),
                        deadline_at,
                        &selection,
                    ) else {
                        continue;
                    };
                    let Ok(batch) = self.collector.collect(job).await else {
                        continue;
                    };
                    let known: HashSet<String> = full.iter().map(RawItem::hash).collect();
                    let fresh: Vec<RawItem> = batch
                        .items
                        .into_iter()
                        .filter(|item| {
                            let hash = item.hash();
                            !hash.is_empty() && !known.contains(&hash)
                        })
                        .collect();
                    if fresh.is_empty() {
                        continue;
                    }
                    full.extend(fresh);
                    let build_items = self
                        .with_fallback(&input, &meta, full.clone(), live_final.as_ref())
                        .await;
                    last = self.finish(&input, &meta, &writer, phase, &build_items, false, None);
                }
            }
        }

        // O índice grava o lote pós-filtro da passada mais nova (idempotente
        // por hash; o TS grava a cada build). Vazio = nada a escrever.
        if !last.filtered.is_empty() || !last.entered.is_empty() {
            let batch = IndexBatch {
                encoded: plan.encoded.clone(),
                releases: vec![release_entry(&meta, &last.entered, &last.filtered)],
            };
            if self.config.index_mode.is_on() && self.index.is_some() {
                self.write_native_index(batch);
            } else if let Err(err) = self.tail.index_write(batch).await {
                eprintln!("[search] index-write tardio falhou: {err}");
            }
        }
        self.emit_effects(&input, &meta, &plan.encoded, &last).await;
    }

    /// `POST /internal/search/index-write` sem HTTP: `releaseIndex.record` no
    /// `cache.db` e (com `BANK_RUST=on`) a marca de `passed_filter` no
    /// `magnets.db`. Falha de UMA entrada não derruba o lote, como na rota.
    fn write_native_index(&self, batch: IndexBatch) {
        let Some(index) = self.index.as_ref() else {
            return;
        };
        let now = now_ms();
        let bank = self.bank.clone();
        let lookup = move |hashes: &[String]| -> Vec<adom_core::BankRow> {
            bank.as_ref()
                .map(|bank| bank.bank_rows_many(hashes))
                .unwrap_or_default()
        };
        let lookup_ref: &dyn Fn(&[String]) -> Vec<adom_core::BankRow> = &lookup;
        for entry in &batch.releases {
            match index.record(entry, now, Some(lookup_ref)) {
                Ok(recorded) => {
                    metrics::global_metrics().inc(metrics::RECORDED, recorded as u64);
                }
                Err(err) => {
                    metrics::global_metrics().inc(metrics::RECORD_FAILED, 1);
                    eprintln!("[search] índice nativo {} falhou: {err}", entry.imdb);
                }
            }
            if !self.config.bank_mode.is_on() {
                continue;
            }
            let Some(bank) = self.bank.as_ref() else {
                metrics::global_metrics().inc(metrics::SOURCE_MISSING, 1);
                continue;
            };
            let entered = entry.entered.as_deref().unwrap_or(&entry.items);
            let survivors = entry.survivors.as_deref().unwrap_or(&entry.items);
            let ctx = BankFilterCtx {
                imdb_id: entry.imdb.clone(),
                season: entry.season,
                episode: entry.episode,
            };
            if bank.mark_filter_outcome(entered, survivors, &ctx, now) {
                metrics::global_metrics().inc(metrics::BANK_MARKED, 1);
            }
        }
    }

    /// Efeitos de cauda: `dub_audit` + warmer (decididos na passada mais nova)
    /// e o episódio seguinte da série com play. `EFFECTS_RUST` default OFF — o
    /// pipeline de debrid do Node continua sendo quem enfileira, e ligar os
    /// dois duplicaria a emissão. Fire-and-forget: quem já recebeu a lista não
    /// depende disto, e falha só vira log.
    async fn emit_effects(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        encoded: &str,
        last: &FinishValue,
    ) {
        if !self.config.effects_enabled {
            return;
        }
        let mut effects = last.effects.clone();
        if let Some(next) = super::effects::harvester_next_episode(
            &input.kind,
            &meta.imdb_id,
            meta.season,
            meta.episode,
            has_playable_stream(&last.entry.streams),
        ) {
            effects.push(next);
        }
        if effects.is_empty() {
            return;
        }
        match self
            .tail
            .effects(EffectsBatch {
                encoded: encoded.to_string(),
                effects,
            })
            .await
        {
            Ok(resp) if resp.rejected > 0 => {
                eprintln!("[search] effects: {} rejeitado(s) pelo Node", resp.rejected)
            }
            Ok(_) => {}
            Err(err) => eprintln!("[search] effects falhou: {err}"),
        }
    }

    /// Sem novidade no lote tardio: promove a entrada parcial existente com as
    /// regras do núcleo (`late_promotion_decision`). `live` é o estado FINAL da
    /// coleta; a decisão só lê `has_any_failure`/`needs_fallback`, como o TS.
    fn promote_late(&self, input: &SearchInput, live: Option<&LiveBatchState>) {
        let now = input.now_ms;
        // `cache.get` do TS: entrada expirada some (graça 0).
        let Some(hit) = self.store.get_with_stale(&input.key, 0, as_ms(now)) else {
            return;
        };
        let live = live.map(|state| adom_core::LiveState {
            needs_fallback: state.needs_fallback(),
            has_any_failure: state.has_any_failure(),
        });
        let decision = late_promotion_decision(&LateFacts {
            hit_partial: hit.value.partial,
            hit_fallback: hit.value.fallback,
            hit_has_streams: !hit.value.streams.is_empty(),
            hit_debrid_known: hit.value.debrid_known == Some(true),
            live,
            cache_ttl: self.config.cache_ttl,
        });
        match decision.action {
            LateAction::Promote => {
                if decision.ttl <= 0 {
                    return;
                }
                let mut entry = hit.value;
                entry.partial = false;
                entry.debrid_known = Some(decision.debrid_known);
                // `trace`/`searchMeta` sobrevivem à promoção (o TS copia).
                self.store.set(
                    &input.key,
                    &to_cacheable_entry(&entry),
                    decision.ttl.max(0) as u64,
                    as_ms(now),
                );
            }
            LateAction::Forget => self.store.forget(&input.key),
            LateAction::None => {}
        }
    }

    fn debrid_refresh_satisfied(&self, input: &SearchInput) -> bool {
        let Some(hit) = self
            .store
            .get_with_stale(&input.key, 0, as_ms(input.now_ms))
        else {
            return false;
        };
        let value = serde_json::to_value(&hit.value).unwrap_or(Value::Null);
        adom_core::debrid_refresh_satisfied(Some(&value))
    }
}
