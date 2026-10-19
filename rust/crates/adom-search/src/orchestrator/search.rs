//! Busca: metadados, janela de coleta, 1ª passada e revalidação SWR.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::Value;

use crate::collection_window::{collect_within_window, CollectTask, CollectWindowOptions};
use crate::latest_writer::LatestWriter;
use crate::raw_item::RawItem;
use crate::request::encoded_for_internal;

use super::collect::plan_jobs;
use super::fast_path::{full_window, merge_fast_with_live};
use super::finish::{cache_max_age_for_finish, is_demo, SearchInput};
use super::live_state::{
    live_state_snapshot, merge_into_shared, merge_states, shared_live_state, LiveBatchState,
    SharedLiveState,
};
use super::meta::{MetaQuery, SearchMeta};
use super::respond::{as_ms, now_ms, SearchOutcome, StreamRequest};
use super::Orchestrator;

impl Orchestrator {
    /// Revalidação em fundo de um hit stale. Mapa PRÓPRIO (`refreshing`): não
    /// coalesce com a busca síncrona nem a impede de começar.
    pub(super) fn spawn_stale_refresh(&self, key: String, req: StreamRequest, options: Value) {
        {
            let mut refreshing = self.refreshing.lock().expect("refreshing");
            if !refreshing.insert(key.clone()) {
                return;
            }
        }
        let this = self.clone();
        tokio::spawn(async move {
            let now = now_ms();
            // Revalida ANTES de pagar a busca: passe tardio, recheck do
            // autofetch ou outra requisição podem ter reescrito a entrada.
            let ainda_stale = this
                .store
                .get_with_stale(&key, this.config.stale_grace_seconds, as_ms(now))
                .map(|hit| hit.stale)
                .unwrap_or(true);
            if ainda_stale {
                let input = SearchInput {
                    kind: req.kind.clone(),
                    id: req.id.clone(),
                    encoded: Some(encoded_for_internal(req.encoded.as_deref())),
                    prefix: req.prefix(),
                    options,
                    key: key.clone(),
                    now_ms: now,
                    // Passe de fundo tem o orçamento COMPLETO (sem deadlineAt
                    // encurtado), como no `scheduleStaleRefresh`.
                    deadline_at: None,
                };
                let in_flight = this.in_flight.clone();
                in_flight
                    .coalesce(&key, || {
                        let this = this.clone();
                        async move { this.run_search(input).await }
                    })
                    .await;
            }
            this.refreshing.lock().expect("refreshing").remove(&key);
        });
    }

    pub(super) async fn run_search(&self, input: SearchInput) -> Arc<SearchOutcome> {
        let writer = Arc::new(LatestWriter::new());
        let phase = writer.phase();
        let meta = self.load_meta(&input).await;

        // Via instantânea do banco e via do índice, na MESMA ordem do
        // `search-index-path.ts`: a instantânea vem primeiro (o route já diz
        // quando ela é elegível, mesmo com o índice coberto).
        let (items, partial, completion, collect_failed, tail_live) =
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
                        )
                    } else {
                        // O TS espera as fontes BR prioritárias ANTES de responder;
                        // globais e passe tardio ficam no tail.
                        let (br_items, _, br_completion, br_failed, br_state) =
                            self.collect_scoped(&input, &meta, Some(true)).await;
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
                        (head, true, Some(completion_handle), false, Some(tail_live))
                    }
                }
                None => {
                    let (items, partial, completion, failed, live_state) =
                        self.collect(&input, &meta).await;
                    (items, partial, completion, failed, Some(live_state))
                }
            };

        let first = self.finish(
            &input,
            &meta,
            &writer,
            phase,
            &items,
            partial,
            input.deadline_at,
        );

        // Fila tardia: o lote COMPLETO chega depois da resposta; o index-write
        // e o refresh/vassourda vão com ele. Sombra §9.1: aborta o completion e
        // NÃO dispara tail (sem SWR/index/effects/debrid em fundo).
        if self.shadow_mode {
            if let Some(handle) = completion {
                handle.abort();
            }
        } else {
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

    async fn load_meta(&self, input: &SearchInput) -> SearchMeta {
        let query = MetaQuery {
            encoded: encoded_for_internal(input.encoded.as_deref()),
            kind: input.kind.clone(),
            id: input.id.clone(),
            // Coleção/1º lançamento doméstico custam uma ida extra ao TMDB —
            // opt-in, como no Node. Filme, e só com debrid ativo.
            include_multiwork: input.kind == "movie",
            include_home_release: input.kind == "movie",
        };
        match self.meta.resolve(query).await {
            Ok(mut meta) => {
                meta.is_demo = is_demo(&input.options);
                if meta.query.is_empty() {
                    // `resolveSearchNames` cai no IMDb id: nunca query vazia.
                    let fallback = SearchMeta::from_id(&input.id);
                    meta.name = fallback.name;
                    meta.names = fallback.names;
                    meta.query = fallback.query;
                }
                meta
            }
            Err(err) => {
                // Falha de metadados não derruba a busca (o TS cai no id).
                eprintln!("[search] metadados falharam para {}: {err}", input.id);
                SearchMeta::from_id(&input.id)
            }
        }
    }

    /// Janela de coleta. Devolve (itens, parcial, completion, todas_falharam,
    /// estado vivo compartilhado). O estado é lido APÓS o completion: lotes que
    /// chegam depois da resposta continuam nele.
    async fn collect(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
    ) -> (
        Vec<RawItem>,
        bool,
        Option<tokio::task::JoinHandle<Vec<RawItem>>>,
        bool,
        SharedLiveState,
    ) {
        self.collect_scoped(input, meta, None).await
    }

    /// Mesma janela, restrita a um grupo: `Some(true)` só as tarefas BR
    /// prioritárias, `Some(false)` só as globais, `None` todas. É o `taskScope`
    /// do `collectRaw` no TS (o índice coberto espera o BR antes de responder).
    pub(super) async fn collect_scoped(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        scope: Option<bool>,
    ) -> (
        Vec<RawItem>,
        bool,
        Option<tokio::task::JoinHandle<Vec<RawItem>>>,
        bool,
        SharedLiveState,
    ) {
        // Relógio de parede (como o `Date.now()` do Node em
        // `computeCollectionBudget`): metadados já consumiram parte do prazo —
        // orçar com `input.now_ms` (início) inflava a coleta e comia a reserva
        // de debrid / o corte externo. Piso 500ms continua no núcleo.
        let budget = self
            .config
            .budgets
            .collection_budget(input.deadline_at, now_ms());
        let jobs = plan_jobs(
            &self.config,
            meta,
            &input.kind,
            input.encoded.as_deref(),
            input.deadline_at.unwrap_or(input.now_ms),
        );
        let jobs: Vec<_> = jobs
            .into_iter()
            .filter(|job| scope.is_none_or(|priority| job.priority == priority))
            .collect();
        let total = jobs.len();
        let failures = Arc::new(AtomicUsize::new(0));
        let batch_partial = Arc::new(AtomicBool::new(false));
        // Estado vivo POR indexer de cada lote. Compartilhado com as tasks: a
        // janela devolve `items` parciais, mas o estado continua sendo
        // acumulado até o completion assentar.
        let live_state = shared_live_state();
        let tasks: Vec<CollectTask<RawItem>> = jobs
            .into_iter()
            .map(|job| {
                let collector = self.collector.clone();
                let failures = failures.clone();
                let batch_partial = batch_partial.clone();
                let live_state = live_state.clone();
                let priority = job.priority;
                CollectTask {
                    fut: Box::pin(async move {
                        match collector.collect(job).await {
                            Ok(batch) => {
                                if batch.partial {
                                    batch_partial.store(true, Ordering::SeqCst);
                                }
                                if let Some(state) = batch.live.as_ref() {
                                    merge_into_shared(&live_state, state);
                                }
                                Ok(batch.items)
                            }
                            Err(err) => {
                                // Erro de tarefa = falha DESCONHECIDA por
                                // indexer: sem contrato, a ausência de estado
                                // não pode virar "respondeu". O agregado
                                // conservador preserva 📦/selos (inclusive de
                                // outro grupo que respondeu) sem apagar falha.
                                merge_into_shared(&live_state, &LiveBatchState::unknown_failure());
                                failures.fetch_add(1, Ordering::SeqCst);
                                Err(err)
                            }
                        }
                    }),
                    priority,
                    source: None,
                }
            })
            .collect();
        let window = collect_within_window(
            tasks,
            CollectWindowOptions {
                budget_ms: budget,
                priority_grace_ms: self.config.budgets.priority_grace(),
                // Série tem fallback de pack: balde vazio não pode gastar a
                // graça esperando BR (a espera sairia do tempo do pack).
                grace_requires_items: meta.season.is_some(),
                is_priority: Box::new(|items: &[RawItem]| items.iter().any(|item| item.is_br)),
                // O recache intermediário do TS (`onBatch`) nunca dispara: o
                // `watchLate` só é armado DEPOIS que a janela retorna. Aqui o
                // equivalente é o passe tardio, que espera o `completion`.
                stop_when: None,
                on_batch: None,
                on_error: Some(Box::new(|err| {
                    eprintln!("[search] fonte falhou: {err}");
                })),
            },
        )
        .await;
        let partial = !window.done || batch_partial.load(Ordering::SeqCst);
        let failed = total > 0 && failures.load(Ordering::SeqCst) == total;
        (
            window.items,
            partial,
            Some(window.completion),
            failed,
            live_state,
        )
    }
}
