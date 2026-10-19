//! Fila tardia: promoção, refresh de debrid, varredura pt-BR e index-write.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::Value;

use adom_core::{late_promotion_decision, LateAction, LateFacts};

use crate::cache::to_cacheable_entry;
use crate::latest_writer::LatestWriter;
use crate::raw_item::RawItem;
use crate::request::encoded_for_internal;

use super::collect;
use super::finish::{release_entry, FinishValue, SearchInput};
use super::meta::SearchMeta;
use super::respond::as_ms;
use super::tail::{IndexBatch, TailJob, TailPlan};
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
        input: SearchInput,
        meta: SearchMeta,
        first: FinishValue,
        partial_items: Vec<RawItem>,
        _partial: bool,
        plan: TailPlan,
        completion: Option<tokio::task::JoinHandle<Vec<RawItem>>>,
        writer: Arc<LatestWriter>,
    ) {
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
        let mut last = first;
        if changed {
            // Fontes lentas chegaram (ou marcas saíram): reconstrói com o lote
            // COMPLETO e regrava (fase atual, revisão mais nova).
            last = self.finish(&input, &meta, &writer, phase, &full, false, None);
        } else {
            // Sem novidade: a entrada parcial é PROMOVIDA pelo `search_finish`
            // (mesmas regras do late promoter do TS).
            self.promote_late(&input);
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
                    last = self.finish(&input, &meta, &writer, phase, &full, false, None);
                }
                TailJob::PtSweep { deadline_at } => {
                    let Some(job) = collect::sweep_job(
                        &self.config,
                        &meta,
                        &input.kind,
                        input.encoded.as_deref(),
                        deadline_at,
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
                    last = self.finish(&input, &meta, &writer, phase, &full, false, None);
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
            if let Err(err) = self.tail.index_write(batch).await {
                eprintln!("[search] index-write tardio falhou: {err}");
            }
        }
        // Efeitos (autofetch/warmer/auditoria/sonda/colhedor/chave de
        // temporada): a DECISÃO ainda mora no pipeline de debrid do Node.
        // O lote sai vazio hoje — `TailEffects::effects` fica pronto para a
        // fatia que ligar a decisão.
    }

    /// Sem novidade no lote tardio: promove a entrada parcial existente com as
    /// regras do núcleo (`late_promotion_decision`).
    fn promote_late(&self, input: &SearchInput) {
        if self.shadow_mode {
            return;
        }
        let now = input.now_ms;
        // `cache.get` do TS: entrada expirada some (graça 0).
        let Some(hit) = self.store.get_with_stale(&input.key, 0, as_ms(now)) else {
            return;
        };
        let decision = late_promotion_decision(&LateFacts {
            hit_partial: hit.value.partial,
            hit_fallback: hit.value.fallback,
            hit_has_streams: !hit.value.streams.is_empty(),
            hit_debrid_known: hit.value.debrid_known == Some(true),
            // Estado vivo dos indexers não é modelado nesta fatia: com `None`
            // a reserva com falha viva é mantida (o ramo conservador).
            live: None,
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
