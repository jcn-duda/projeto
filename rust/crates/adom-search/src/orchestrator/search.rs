//! Busca: metadados, janela de coleta, 1ª passada e revalidação SWR.

use std::sync::Arc;

use crate::latest_writer::LatestWriter;

use super::fast_path::{full_window, merge_fast_with_live};
use super::finish::{cache_max_age_for_finish, SearchInput};
use super::live_state::{live_state_snapshot, merge_into_shared, merge_states, shared_live_state};
use super::respond::{now_ms, SearchOutcome};
use super::Orchestrator;

impl Orchestrator {
    pub(super) async fn run_search(&self, input: SearchInput) -> Arc<SearchOutcome> {
        let writer = Arc::new(LatestWriter::new());
        let phase = writer.phase();
        let meta = self.load_meta(&input).await;
        let mut used_pack_fallback = false;

        // Via instantânea do banco e via do índice, na MESMA ordem do
        // `search-index-path.ts`: a instantânea vem primeiro (o route já diz
        // quando ela é elegível, mesmo com o índice coberto).
        // `first_live` é o estado visto pela PRIMEIRA build (a reserva 📦 é
        // reinjetada antes do build, como o `collectFallbackForBuild` do TS).
        // O `tail_live` compartilhado segue acumulando para a promoção tardia.
        let (items, partial, completion, collect_failed, tail_live, first_live) =
            match self.fast_path_items(&input, &meta).await {
                Some(fast) if fast.instant => {
                    // A resposta sai do acervo; a coleta ao vivo inteira roda
                    // no tail e entra por promoção tardia.
                    let fast_items = fast.items;
                    let this = self.clone();
                    let input_tail = self.tail_input(&input);
                    let meta_tail = meta.clone();
                    let fast_for_tail = fast_items.clone();
                    // O tail precisa do estado FINAL pós-completion para a
                    // promoção tardia; a task o espelha no compartilhado.
                    let tail_live = shared_live_state();
                    let tail_live_task = tail_live.clone();
                    let completion_handle = tokio::spawn(async move {
                        let (live_items, _, completion, failed, live_state) =
                            this.collect(&input_tail, &meta_tail).await;
                        let live = full_window(live_items, completion).await;
                        // `full_window` já aguardou todas as tasks: o estado
                        // compartilhado está FINAL (inclui lote pós-resposta).
                        let state = live_state_snapshot(&live_state);
                        if let Some(state) = state.as_ref() {
                            merge_into_shared(&tail_live_task, state);
                        }
                        merge_fast_with_live(fast_for_tail, live, failed, state.as_ref())
                    });
                    (
                        fast_items,
                        true,
                        Some(completion_handle),
                        false,
                        Some(tail_live),
                        None,
                    )
                }
                Some(fast) => {
                    let prelim = self.finish(
                        &input,
                        &meta,
                        &writer,
                        phase,
                        &fast.items,
                        true,
                        input.deadline_at,
                    );
                    let remaining_ms = input.deadline_at.unwrap_or(0) - now_ms();
                    let needs_rescue = self.config.search_index_rescue_min_ms > 0
                        && !crate::cache::has_playable_stream(&prelim.entry.streams)
                        && remaining_ms >= self.config.search_index_rescue_min_ms;
                    if needs_rescue {
                        // Resgate: o índice respondeu sem nenhum stream tocável;
                        // a coleta ao vivo roda agora, na própria resposta.
                        let (live_items, live_partial, live_completion, live_failed, live_state) =
                            self.collect(&input, &meta).await;
                        let mut merged = fast.items.clone();
                        merged.extend(live_items.iter().cloned());
                        let fast_for_rescue = fast.items;
                        let tail_live = live_state.clone();
                        let first_live = live_state_snapshot(&live_state);
                        let completion = Some(tokio::spawn(async move {
                            let live = full_window(live_items, live_completion).await;
                            let state = live_state_snapshot(&live_state);
                            merge_fast_with_live(fast_for_rescue, live, live_failed, state.as_ref())
                        }));
                        (
                            merged,
                            live_partial,
                            completion,
                            live_failed,
                            Some(tail_live),
                            first_live,
                        )
                    } else {
                        // O TS espera as fontes BR prioritárias ANTES de responder;
                        // globais e passe tardio ficam no tail.
                        let (br_items, _, br_completion, br_failed, br_state) =
                            self.collect_scoped(&input, &meta, Some(true)).await;
                        // A primeira resposta espera o BR prioritário: o estado
                        // dessa coleta é o que decide a reserva dos BRs falhos.
                        let first_live = live_state_snapshot(&br_state);
                        let mut head = fast.items.clone();
                        head.extend(br_items.iter().cloned());
                        let this = self.clone();
                        let input_tail = self.tail_input(&input);
                        let meta_tail = meta.clone();
                        let fast_for_tail = fast.items;
                        let tail_live = shared_live_state();
                        let tail_live_task = tail_live.clone();
                        let completion_handle = tokio::spawn(async move {
                            let (global_items, _, global_completion, global_failed, global_state) =
                                this.collect_scoped(&input_tail, &meta_tail, Some(false))
                                    .await;
                            let mut live = full_window(br_items, br_completion).await;
                            live.extend(full_window(global_items, global_completion).await);
                            // Grupo sem tarefa nunca "falha": sem nenhum item ao vivo e
                            // com um grupo falho, a coleta conta como toda falha.
                            let all_failed = (br_failed && global_failed)
                                || ((br_failed || global_failed) && live.is_empty());
                            // As duas janelas já assentaram: união do estado FINAL,
                            // como o `mergeLiveIndexerStates([raw.live, enrichment.live])`.
                            let state = merge_states([
                                live_state_snapshot(&br_state),
                                live_state_snapshot(&global_state),
                            ]);
                            if let Some(state) = state.as_ref() {
                                merge_into_shared(&tail_live_task, state);
                            }
                            merge_fast_with_live(fast_for_tail, live, all_failed, state.as_ref())
                        });
                        (
                            head,
                            true,
                            Some(completion_handle),
                            false,
                            Some(tail_live),
                            first_live,
                        )
                    }
                }
                None => {
                    let (items, partial, completion, failed, live_state) =
                        self.collect(&input, &meta).await;
                    // Série sem nada útil no episódio: o pack da temporada
                    // SUBSTITUI a coleta (o `needsPack` do TS).
                    match self.pack_fallback(&input, &meta, &items, partial).await {
                        Some((items, partial, completion, failed, live_state)) => {
                            used_pack_fallback = true;
                            let first_live = live_state_snapshot(&live_state);
                            (
                                items,
                                partial,
                                completion,
                                failed,
                                Some(live_state),
                                first_live,
                            )
                        }
                        None => {
                            let first_live = live_state_snapshot(&live_state);
                            (
                                items,
                                partial,
                                completion,
                                failed,
                                Some(live_state),
                                first_live,
                            )
                        }
                    }
                }
            };
        // Pack tardio em toda via (também a do índice), menos quando o
        // fallback já buscou o pack.
        let completion = if used_pack_fallback {
            completion
        } else {
            self.with_pack_tail(&input, &meta, items.clone(), completion, tail_live.as_ref())
        };

        // Reserva 📦 da PRIMEIRA build: o lote canônico (`items`) continua sem
        // ela; a cópia é que vai ao build, como o `buildInput` do TS.
        let first_items = self
            .with_fallback(&input, &meta, items.clone(), first_live.as_ref())
            .await;
        let first = self.finish(
            &input,
            &meta,
            &writer,
            phase,
            &first_items,
            partial,
            input.deadline_at,
        );

        // Fila tardia: o lote COMPLETO chega depois da resposta; o index-write
        // e o refresh/vassourda vão com ele.
        let tail_items = items.clone();
        let plan = self.tail_plan(&input, &meta, &first, partial);
        if !plan.is_empty() || completion.is_some() {
            let this = self.clone();
            let writer = writer.clone();
            let tail_first = first.clone();
            tokio::spawn(async move {
                this.run_tail(
                    input, meta, tail_first, tail_items, partial, plan, completion, tail_live,
                    writer,
                )
                .await;
            });
        }
        let cache_max_age = cache_max_age_for_finish(&first, collect_failed, &self.config);
        Arc::new(SearchOutcome {
            entry: first.entry,
            partial: first.partial,
            collect_failed,
            needs_debrid_refresh: first.needs_debrid_refresh,
            cache_max_age,
        })
    }
}
