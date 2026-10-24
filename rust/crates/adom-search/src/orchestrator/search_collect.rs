//! Janela de coleta e plano da conta (por grupo: BR, globais e a conta).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use adom_core::RelevanceSettings;
use serde_json::Value;

use crate::collection_window::{collect_within_window, CollectTask, CollectWindowOptions};
use crate::raw_item::RawItem;

use super::account::{account_raw_items, fast_path_decision, record_fast_path, AccountRequest};
use super::account_metrics;
use super::collect::plan_jobs;
use super::finish::{bool_of, str_of, SearchInput};
use super::live_state::{merge_into_shared, shared_live_state, LiveBatchState, SharedLiveState};
use super::meta::SearchMeta;
use super::respond::now_ms;
use super::Orchestrator;

/// `stop_when` da janela para o fast-path da conta (lote, balde, fonte).
type AccountStopWhen =
    Box<dyn Fn(&[RawItem], &[RawItem], &crate::collection_window::BatchMeta) -> bool + Send>;

impl Orchestrator {
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
        // Fonte da conta: SEMPRE a nativa. A tarefa é PRÓPRIA nos grupos não
        // prioritários: a primeira leitura custa ~100 ms e, dentro do
        // `nonpriority`, esperava o indexer global mais lento (4 s+).
        let account_plan = if scope == Some(true) {
            None
        } else {
            self.account_plan(&input.options)
        };
        // Fast-path da conta: só quando a conta VAI entrar (fonte nativa já
        // injetada); sem fonte não há lote para parar a janela. O
        // `ACCOUNT_FAST_PATH` reproduz o kill-switch do operador.
        let fast_path_on = self.config.account_fast_path
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

    /// Plano da tarefa da conta para esta busca. `None` = P2P puro / serviço
    /// desconhecido / sem fonte injetada, como o antigo `accountSource` do TS
    /// quando não há debrid.
    fn account_plan(&self, options: &Value) -> Option<AccountPlan> {
        let req = AccountRequest {
            service: str_of(options, "debridService"),
            api_key: str_of(options, "debridApiKey"),
        };
        // `debrid.current()` do Node: serviço DESCONHECIDO não tem adaptador —
        // não é P2P puro, mas também não é fonte.
        let known_service = adom_debrid::account::is_known_service(&req.service);
        if !req.is_active() || !known_service || !self.config.account_inventory_source {
            return None;
        }
        if self.account.is_none() {
            // Degradação honesta: sem fonte injetada, a conta não entra em vez
            // de voltar para a tarefa Node (a coleta do Node não existe mais).
            account_metrics::global_metrics().inc(account_metrics::SOURCE_MISSING, 1);
            eprintln!("[account] sem fonte nativa de inventário; a conta fica fora desta busca");
            return None;
        }
        Some(AccountPlan::Native {
            label: adom_debrid::account::label_of(&req.service).to_string(),
            req,
        })
    }
}

/// Plano da conta para UMA coleta (só a fonte nativa existe).
enum AccountPlan {
    Native { req: AccountRequest, label: String },
}
