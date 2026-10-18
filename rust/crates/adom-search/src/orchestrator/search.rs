//! Busca: metadados, janela de coleta, 1ª passada e revalidação SWR.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::Value;

use crate::collection_window::{collect_within_window, CollectTask, CollectWindowOptions};
use crate::latest_writer::LatestWriter;
use crate::raw_item::RawItem;
use crate::request::encoded_for_internal;

use super::collect::plan_jobs;
use super::finish::{cache_max_age_for_finish, is_demo, SearchInput};
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
        let (items, partial, completion, collect_failed) = self.collect(&input, &meta).await;
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
                        input, meta, tail_first, tail_items, partial, plan, completion, writer,
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

    /// Janela de coleta. Devolve (itens, parcial, completion, todas_falharam).
    async fn collect(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
    ) -> (
        Vec<RawItem>,
        bool,
        Option<tokio::task::JoinHandle<Vec<RawItem>>>,
        bool,
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
        let total = jobs.len();
        let failures = Arc::new(AtomicUsize::new(0));
        let batch_partial = Arc::new(AtomicBool::new(false));
        let tasks: Vec<CollectTask<RawItem>> = jobs
            .into_iter()
            .map(|job| {
                let collector = self.collector.clone();
                let failures = failures.clone();
                let batch_partial = batch_partial.clone();
                let priority = job.priority;
                CollectTask {
                    fut: Box::pin(async move {
                        match collector.collect(job).await {
                            Ok(batch) => {
                                if batch.partial {
                                    batch_partial.store(true, Ordering::SeqCst);
                                }
                                Ok(batch.items)
                            }
                            Err(err) => {
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
        (window.items, partial, Some(window.completion), failed)
    }
}
