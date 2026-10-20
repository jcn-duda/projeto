//! Busca: metadados, janela de coleta, 1ª passada e revalidação SWR.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use adom_core::RelevanceSettings;
use serde_json::Value;
use tokio::sync::oneshot;

use crate::collection_window::{collect_within_window, CollectTask, CollectWindowOptions};
use crate::latest_writer::LatestWriter;
use crate::raw_item::{raw_item_from_value, RawItem};

use super::account::{
    account_raw_items, fast_path_decision, record_fast_path, sampled, AccountMode, AccountRequest,
};
use super::account_metrics;
use super::account_shadow::spawn_shadow_compare;
use super::collect::{account_request_from_job, plan_jobs, CollectJob};
use super::fast_path::{full_window, merge_fast_with_live};
use super::finish::{bool_of, cache_max_age_for_finish, str_of, SearchInput};
use super::live_state::{
    live_state_snapshot, merge_into_shared, merge_states, shared_live_state, LiveBatchState,
    SharedLiveState,
};
use super::meta::SearchMeta;
use super::respond::{now_ms, SearchOutcome};
use super::Orchestrator;

/// `stop_when` da janela para o fast-path da conta (lote, balde, fonte).
type AccountStopWhen =
    Box<dyn Fn(&[RawItem], &[RawItem], &crate::collection_window::BatchMeta) -> bool + Send>;

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

    /// Janela de coleta. Devolve (itens, parcial, completion, todas_falharam,
    /// estado vivo compartilhado). O estado é lido APÓS o completion: lotes que
    /// chegam depois da resposta continuam nele.
    pub(super) async fn collect(
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
            &super::collect::RequestSelection::from_options(
                &input.options,
                self.config.mico_default,
            ),
        );
        // Fonte da conta: Node (default), nativa (`ACCOUNT_RUST=on`) ou Node +
        // sombra nativa (`ACCOUNT_RUST=shadow`). A tarefa é PRÓPRIA nos grupos
        // não prioritários: a primeira leitura custa ~100 ms e, dentro do
        // `nonpriority`, esperava o indexer global mais lento (4 s+).
        let account_base = if !self.shadow_mode && scope != Some(true) {
            jobs.iter()
                .find(|job| !job.priority)
                .or(jobs.first())
                .cloned()
        } else {
            None
        };
        let account_plan =
            account_base.and_then(|job| self.account_plan(job, &input.options, meta));
        // Fast-path da conta: só no modo NATIVO (o Node tem o dele dentro do
        // `collectRaw`; o nativo precisa parar a janela aqui). `ACCOUNT_FAST_PATH`
        // reproduz o kill-switch do operador.
        let fast_path_on = self.config.account_mode.is_on()
            && self.config.account_fast_path
            && matches!(&account_plan, Some(AccountPlan::Native { .. }));
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
        let mut tasks: Vec<CollectTask<RawItem>> = jobs
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
        match account_plan {
            None => {}
            Some(AccountPlan::Node(job)) => {
                if let Some(routes) = self.routes.clone() {
                    account_metrics::global_metrics().inc(account_metrics::NODE, 1);
                    tasks.push(CollectTask {
                        fut: Box::pin(async move {
                            // Falha da conta não conta como falha de coleta nem
                            // apaga a reserva 📦: o Node já a tratava como fonte
                            // neutra.
                            match routes.collect(account_request_from_job(job)).await {
                                Ok(resp) => {
                                    Ok(resp.items.iter().map(raw_item_from_value).collect())
                                }
                                Err(err) => {
                                    eprintln!("[search] conta do debrid falhou: {err}");
                                    Ok(Vec::new())
                                }
                            }
                        }),
                        priority: false,
                        source: None,
                    });
                }
            }
            Some(AccountPlan::Native { req, label }) => {
                if let Some(source) = self.account.clone() {
                    let meta = meta.clone();
                    let settings = self.account_settings();
                    tasks.push(CollectTask {
                        fut: Box::pin(async move {
                            match source.inventory(req).await {
                                Ok(inventory) if inventory.is_unusable() => {
                                    eprintln!(
                                        "[account] conta inutilizável ({}); fonte pulada",
                                        inventory
                                            .unusable
                                            .as_ref()
                                            .map(|(kind, _)| kind.as_str())
                                            .unwrap_or("desconhecido")
                                    );
                                    Ok(Vec::new())
                                }
                                Ok(inventory) => {
                                    let items = account_raw_items(
                                        &inventory.items,
                                        &meta,
                                        settings,
                                        &label,
                                    );
                                    if !items.is_empty() {
                                        eprintln!(
                                            "[account] {} item(ns) pronto(s) na conta entraram como fonte (nativo)",
                                            items.len()
                                        );
                                    }
                                    Ok(items)
                                }
                                Err(err) => {
                                    eprintln!("[account] inventário nativo indisponível: {err}");
                                    Ok(Vec::new())
                                }
                            }
                        }),
                        priority: false,
                        source: Some("account".to_string()),
                    });
                }
            }
            Some(AccountPlan::Shadow { job, req, label }) => {
                if let (Some(routes), Some(source)) = (self.routes.clone(), self.account.clone()) {
                    account_metrics::global_metrics().inc(account_metrics::NODE, 1);
                    // O clone do lote Node viaja para a comparação por oneshot:
                    // a sombra NÃO faz uma segunda chamada à rota e NÃO segura o
                    // cliente (a tarefa devolve assim que o Node responde).
                    let (tx, rx) = oneshot::channel();
                    tasks.push(CollectTask {
                        fut: Box::pin(async move {
                            match routes.collect(account_request_from_job(job)).await {
                                Ok(resp) => {
                                    let items: Vec<RawItem> =
                                        resp.items.iter().map(raw_item_from_value).collect();
                                    let _ = tx.send(Ok(items.clone()));
                                    Ok(items)
                                }
                                Err(err) => {
                                    eprintln!("[search] conta do debrid falhou: {err}");
                                    let _ = tx.send(Err(err));
                                    Ok(Vec::new())
                                }
                            }
                        }),
                        priority: false,
                        source: None,
                    });
                    spawn_shadow_compare(
                        source,
                        req,
                        label,
                        meta.clone(),
                        self.account_settings(),
                        rx,
                        std::time::Duration::from_millis(
                            self.config.account_shadow_timeout_ms.max(1) as u64,
                        ),
                    );
                }
            }
        }
        let stop_when: Option<AccountStopWhen> = if fast_path_on {
            let min_releases = self.config.account_fast_min_releases;
            let prefer_dubbed = bool_of(&input.options, "preferDubbed");
            let season = meta.season;
            let min_seeders = self.config.account_fast_min_seeders;
            Some(Box::new(
                move |batch: &[RawItem],
                      _items: &[RawItem],
                      batch_meta: &crate::collection_window::BatchMeta| {
                    let decision = fast_path_decision(
                        batch,
                        batch_meta,
                        min_releases,
                        prefer_dubbed,
                        season,
                        min_seeders,
                    );
                    record_fast_path(decision);
                    if decision.stops() {
                        eprintln!(
                            "[search] conta suficiente ({} release(s)); respondendo sem esperar a coleta",
                            batch.len()
                        );
                    }
                    decision.stops()
                },
            ))
        } else {
            None
        };
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
                stop_when,
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

    /// Config de relevância do filtro da conta: as MESMAS chaves que o build
    /// usa (`preHomeReleaseCut`/margem/cauda). O relógio é por chamada.
    fn account_settings(&self) -> RelevanceSettings {
        RelevanceSettings {
            now_ms: now_ms(),
            pre_home_release_cut: self.config.build.pre_home_release_cut,
            pre_home_release_margin_ms: self.config.build.pre_home_release_margin_ms,
            title_precision_tail_cut: self.config.build.title_precision_tail_cut,
        }
    }

    /// Plano da tarefa da conta para esta busca. `None` = P2P puro / sem fonte,
    /// exatamente como o `accountSource` do TS quando não há debrid.
    fn account_plan(
        &self,
        job: CollectJob,
        options: &Value,
        meta: &SearchMeta,
    ) -> Option<AccountPlan> {
        let req = AccountRequest {
            service: str_of(options, "debridService"),
            api_key: str_of(options, "debridApiKey"),
        };
        // `debrid.current()` do Node: serviço DESCONHECIDO não tem adaptador —
        // não é P2P puro, mas também não é fonte.
        let known_service = adom_debrid::account::is_known_service(&req.service);
        match self.config.account_mode {
            AccountMode::Off => self.routes.as_ref().map(|_| AccountPlan::Node(job)),
            AccountMode::Shadow => {
                // Sem rotas Node ou sem fonte não há par a comparar; a resposta
                // continua a de sempre (nunca vira fonte neste modo). Conta
                // desligada pelo operador também não gera par (o Node devolve
                // vazio de propósito e comparar seria divergência falsa).
                if self.routes.is_none()
                    || self.account.is_none()
                    || !req.is_active()
                    || !known_service
                    || !self.config.account_inventory_source
                {
                    return self.routes.as_ref().map(|_| AccountPlan::Node(job));
                }
                if !sampled(&meta.imdb_id, self.config.account_shadow_sample) {
                    account_metrics::global_metrics().inc(account_metrics::SHADOW_NOT_SAMPLED, 1);
                    return Some(AccountPlan::Node(job));
                }
                Some(AccountPlan::Shadow {
                    job,
                    label: adom_debrid::account::label_of(&req.service).to_string(),
                    req,
                })
            }
            AccountMode::On => {
                if !req.is_active() || !known_service || !self.config.account_inventory_source {
                    return None;
                }
                if self.account.is_some() {
                    Some(AccountPlan::Native {
                        label: adom_debrid::account::label_of(&req.service).to_string(),
                        req,
                    })
                } else {
                    // Degradação honesta: sem fonte injetada, a conta continua
                    // no Node em vez de sumir da lista.
                    account_metrics::global_metrics().inc(account_metrics::SOURCE_MISSING, 1);
                    eprintln!("[account] ACCOUNT_RUST=on sem fonte nativa; usando a tarefa Node");
                    self.routes.as_ref().map(|_| AccountPlan::Node(job))
                }
            }
        }
    }
}

/// Plano da conta para UMA coleta (Node, nativa ou Node+sombra).
enum AccountPlan {
    Node(CollectJob),
    Native {
        req: AccountRequest,
        label: String,
    },
    Shadow {
        job: CollectJob,
        req: AccountRequest,
        label: String,
    },
}
