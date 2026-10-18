//! MONTAGEM do orquestrador do `GET /:encoded/stream/:type/:id.json`.
//!
//! A ordem é a de `src/providers/search-cache.ts` + `search-orchestrator.ts`:
//!
//! 1. **identidade** — config do `encoded` (URL), chave SWR `streams:v21`,
//!    prazo por User-Agent (Stremio × app `Dart/`);
//! 2. **SWR** — hit completo serve na hora; hit na graça serve E revalida em
//!    fundo (mapa `refreshing` separado do `inFlight`); incompleto é miss;
//! 3. **coalescing** — buscas idênticas simultâneas dividem UMA computação;
//! 4. **busca** — metadados → plano (`search_plan`) → janela
//!    (`collect_within_window`) com a coleta INJETADA (trait [`Collector`]),
//!    orçamento = prazo − reserva de debrid, graça para a 1ª fonte BR;
//! 5. **build** — `build_stream_list` com o `DebridCheck` injetado; a URL de
//!    `/resolve` (HMAC) é materializada AQUI, porque o segredo/prefixo são da
//!    requisição;
//! 6. **fim** — `search_finish` do núcleo (`commit_decision` / promoção
//!    tardia), `cacheMaxAge`, e o host só na resposta (`apply_notice_origin`);
//! 7. **fila tardia** — `tokio::spawn` com o lote completo, index-write,
//!    refresh do debrid e varredura pt-BR (efeitos por [`TailEffects`]).
//!
//! Corte EXTERNO: a busca corre numa task própria; o cliente espera
//! `reply_ms` e, se o prazo vencer, recebe `partial` com o aviso
//! "Procurando fontes — reabra em instantes" e `cacheMaxAge: 0`. A task NÃO é
//! cancelada: quando a coleta estabiliza, o passe tardio regrava o cache
//! (mesmo cache ≤ 60 s e host fora dele). Nunca 500: falha de collector vira
//! lista vazia + aviso, como o handler do Node (`stream.ts`).

mod collect;
mod config;
mod internal_routes;
mod meta;
mod tail;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
mod trace;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use adom_core::{commit_decision, late_promotion_decision, CommitFacts, LateAction, LateFacts};

use crate::cache::{
    has_playable_stream, swr_lookup, to_cacheable_entry, StreamsEntry, SwrLookup, SwrStore,
};
use crate::coalesce::InFlight;
use crate::collection_window::{collect_within_window, CollectTask, CollectWindowOptions};
use crate::contract::{StreamItem, StreamResponse};
use crate::internal_types::ReleaseEntry;
use crate::latest_writer::LatestWriter;
use crate::list_builder::{apply_notice_origin, build_stream_list, BuildContext, BuiltStream};
use crate::raw_item::RawItem;
use crate::request::{
    encoded_for_internal, parse_stream_path, reply_deadline_ms, request_cache_key,
};
use crate::resolve_url::ResolveSigner;

pub use collect::{plan_jobs, CollectBatch, CollectJob, Collector, NodeCollector};
pub use config::{
    build_options_from, AdapterDebridFactory, DebridContext, DebridFactory, NoDebridCheck,
    NoDebridFactory, OrchestratorConfig,
};
pub use internal_routes::{InternalRoutes, NodeRoutes, RouteFuture};
pub use meta::{meta_from_response, MetaQuery, MetaSource, NodeMetaSource, SearchMeta};
pub use tail::{
    EffectsBatch, IndexBatch, NodeTailEffects, NoopTailEffects, TailEffects, TailJob, TailPlan,
};
pub use trace::{new_trace, TraceInput, TraceRecord, TraceResponseFacts};

/// Aviso do corte externo — o MESMO texto do Node (`search-cache.ts:169-176`).
pub const NOTICE_SEARCHING: &str = "Procurando fontes — reabra em instantes";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Relógio da busca (i64, porque o orçamento do núcleo é i64) → o `u64` que o
/// store SWR usa. Clamp em 0: relógio antes da época não gera instante válido.
fn as_ms(now: i64) -> u64 {
    now.max(0) as u64
}

/// Requisição `/stream` já separada. `origin` é o host de QUEM PERGUNTA: entra
/// só na resposta, nunca no cache.
#[derive(Debug, Clone, Default)]
pub struct StreamRequest {
    pub kind: String,
    pub id: String,
    pub encoded: Option<String>,
    pub user_agent: Option<String>,
    /// `https://host[:port]` — o `origin()` do Node (já validado lá).
    pub origin: Option<String>,
    /// Relógio injetado (teste determinístico); `None` = agora.
    pub now_ms: Option<i64>,
}

impl StreamRequest {
    /// Açúcar para o servidor: caminho cru + UA + origin.
    ///
    /// Sem `/:userConfig` na URL, o segmento vira o canônico `e30` (`{}`): as
    /// rotas internas do Node exigem `encoded` não-vazio no corpo.
    pub fn from_path(
        path: &str,
        user_agent: Option<&str>,
        origin: Option<&str>,
        now_ms: Option<i64>,
    ) -> Option<Self> {
        let target = parse_stream_path(path)?;
        Some(StreamRequest {
            kind: target.kind,
            id: target.id,
            encoded: Some(encoded_for_internal(target.encoded.as_deref())),
            user_agent: user_agent.map(str::to_string),
            origin: origin.map(|o| o.trim_end_matches('/').to_string()),
            now_ms,
        })
    }

    /// `/<config>` — prefixo das URLs de play e do aviso (sempre com segmento
    /// após [`Self::from_path`]; fallback canônico se montado à mão sem encoded).
    pub fn prefix(&self) -> String {
        format!("/{}", encoded_for_internal(self.encoded.as_deref()))
    }
}

/// Resultado de UMA busca computada (o que o coalescing compartilha).
#[derive(Debug, Clone)]
pub struct SearchOutcome {
    pub entry: StreamsEntry,
    /// A coleta não terminou dentro do orçamento.
    pub partial: bool,
    /// Nenhuma fonte respondeu (erro de collector): a lista vazia é "sem
    /// resposta", não "sem resultado".
    pub collect_failed: bool,
    /// A checagem do debrid precisa ser refeita (passe tardio).
    pub needs_debrid_refresh: bool,
    /// `cacheMaxAge` já decidido (`0` = revalidar).
    pub cache_max_age: u32,
}

/// Entrada de uma computação (nada de referência à requisição que morreu).
#[derive(Clone)]
struct SearchInput {
    kind: String,
    id: String,
    encoded: Option<String>,
    prefix: String,
    options: Value,
    key: String,
    now_ms: i64,
    /// `None` = passe tardio, sem prazo de cliente.
    deadline_at: Option<i64>,
}

/// O que a passada de build produziu, além da entrada gravável.
#[derive(Clone)]
struct FinishValue {
    entry: StreamsEntry,
    /// Lote pré-filtro de título (`entered` do banco de magnets).
    entered: Vec<RawItem>,
    /// Lote pós-filtro de título (matéria-prima do índice de releases).
    filtered: Vec<RawItem>,
    partial: bool,
    debrid_known: bool,
    needs_debrid_refresh: bool,
    commit_write: bool,
    commit_ttl: i64,
}

/// O orquestrador. Clonável e barato: tudo atrás de `Arc`.
#[derive(Clone)]
pub struct Orchestrator {
    config: Arc<OrchestratorConfig>,
    store: Arc<dyn SwrStore>,
    collector: Arc<dyn Collector>,
    meta: Arc<dyn MetaSource>,
    debrid: Arc<dyn DebridFactory>,
    tail: Arc<dyn TailEffects>,
    in_flight: Arc<InFlight<Arc<SearchOutcome>>>,
    refreshing: Arc<Mutex<HashSet<String>>>,
    /// `true` = sombra §9.1: sem debrid, sem gravar SWR, sem fila tardia /
    /// index-write / effects / refresh em fundo. Só produz corpo para comparar.
    shadow_mode: bool,
}

/// Collector que falha sempre: default do crate até a integração injetar o
/// `NodeCollector`. A busca responde lista vazia + aviso — nunca 500.
struct UnavailableCollector;

impl Collector for UnavailableCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async { Err("collector não configurado".to_string()) })
    }
}

/// `MetaSource` mínimo: deriva do id (sem rede). É o default do crate e o
/// fallback de quem não injetou o Node.
struct IdOnlyMeta;

impl MetaSource for IdOnlyMeta {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move { Ok(SearchMeta::from_id(&req.id)) })
    }
}

impl Orchestrator {
    /// Só a config e o store SWR são obrigatórios; o resto degrada para um
    /// stub que NÃO inventa resultado (collector erra, meta lê o id, debrid
    /// não responde, efeitos não são entregues).
    pub fn new(config: OrchestratorConfig, store: Arc<dyn SwrStore>) -> Self {
        Orchestrator {
            config: Arc::new(config),
            store,
            collector: Arc::new(UnavailableCollector),
            meta: Arc::new(IdOnlyMeta),
            debrid: Arc::new(AdapterDebridFactory::default()),
            tail: Arc::new(NoopTailEffects),
            in_flight: Arc::new(InFlight::new()),
            refreshing: Arc::new(Mutex::new(HashSet::new())),
            shadow_mode: false,
        }
    }

    pub fn with_collector(mut self, collector: Arc<dyn Collector>) -> Self {
        self.collector = collector;
        self
    }

    pub fn with_meta(mut self, meta: Arc<dyn MetaSource>) -> Self {
        self.meta = meta;
        self
    }

    pub fn with_debrid(mut self, debrid: Arc<dyn DebridFactory>) -> Self {
        self.debrid = debrid;
        self
    }

    pub fn with_tail(mut self, tail: Arc<dyn TailEffects>) -> Self {
        self.tail = tail;
        self
    }

    /// Liga o modo sombra (§9.1): compare-only — sem efeitos colaterais.
    pub fn with_shadow_mode(mut self, enabled: bool) -> Self {
        self.shadow_mode = enabled;
        self
    }

    /// Liga coleta/metadados/efeitos no cliente HTTP das rotas internas.
    pub fn with_routes(mut self, routes: Arc<dyn InternalRoutes>) -> Self {
        self.collector = Arc::new(NodeCollector::new(routes.clone()));
        self.meta = Arc::new(NodeMetaSource::new(routes.clone()));
        self.tail = Arc::new(NodeTailEffects::new(routes));
        self
    }

    pub fn config(&self) -> &OrchestratorConfig {
        &self.config
    }

    /// `true` quando montado para sombra compare-only (§9.1).
    pub fn shadow_mode(&self) -> bool {
        self.shadow_mode
    }

    /// Quantas buscas estão coalescendo agora (snapshot do painel).
    pub fn searches_in_flight(&self) -> usize {
        self.in_flight.len()
    }

    /// A rota: devolve SEMPRE `StreamResponse` (o `/stream` quase não usa
    /// status de erro — não-200 é "addon quebrado" para o Stremio).
    pub async fn handle(&self, req: StreamRequest) -> StreamResponse {
        let now = req.now_ms.unwrap_or_else(now_ms);
        if !req.id.starts_with("tt") {
            return empty_response();
        }
        let prefix = req.prefix();
        let options = self.resolve_options(&req.encoded);
        let key = request_cache_key(&req.kind, &req.id, &self.key_options(&options));
        let reply_ms = reply_deadline_ms(
            req.user_agent.as_deref(),
            self.config.stremio_reply_ms,
            self.config.app_reply_ms,
        );
        let deadline_at = Some(now.saturating_add(reply_ms as i64));

        // SWR: `getWithStale` (não `get`) — a entrada expirada DENTRO da graça
        // é justamente a que o SWR quer servir enquanto revalida.
        let hit = self
            .store
            .get_with_stale(&key, self.config.stale_grace_seconds, as_ms(now));
        match swr_lookup(hit) {
            SwrLookup::Serve { entry, revalidate } => {
                // Sombra não revalida em fundo (não grava cache / não CHAMa debrid).
                if revalidate && !self.shadow_mode {
                    self.spawn_stale_refresh(key.clone(), req.clone(), options.clone());
                }
                return self.respond_entry(&entry, &req);
            }
            SwrLookup::Miss => {}
        }

        let input = SearchInput {
            kind: req.kind.clone(),
            id: req.id.clone(),
            encoded: Some(encoded_for_internal(req.encoded.as_deref())),
            prefix: prefix.clone(),
            options,
            key: key.clone(),
            now_ms: now,
            deadline_at,
        };
        // A busca corre numa TASK própria: o `timeout` abaixo corta só a
        // ESPERA. Se o prazo vencer, a task continua e o passe tardio grava.
        let task = tokio::spawn({
            let this = self.clone();
            let in_flight = self.in_flight.clone();
            let key = key.clone();
            async move {
                in_flight
                    .coalesce(&key, || async move { this.run_search(input).await })
                    .await
            }
        });
        let outcome = match tokio::time::timeout(Duration::from_millis(reply_ms), task).await {
            Ok(Ok(outcome)) => outcome,
            // Corrida perdida (prazo) ou task que panicou: o cliente recebe o
            // estado parcial do Node — aviso + cacheMaxAge 0.
            Ok(Err(_)) | Err(_) => {
                eprintln!(
                    "[search] prazo de {reply_ms}ms atingido para {}; segue em background",
                    req.id
                );
                return self.respond_notice(&req, NOTICE_SEARCHING);
            }
        };
        self.respond_outcome(&outcome, &req)
    }

    // ── SWR ────────────────────────────────────────────────────────────────

    /// Revalidação em fundo de um hit stale. Mapa PRÓPRIO (`refreshing`): não
    /// coalesce com a busca síncrona nem a impede de começar.
    fn spawn_stale_refresh(&self, key: String, req: StreamRequest, options: Value) {
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

    // ── Busca ──────────────────────────────────────────────────────────────

    async fn run_search(&self, input: SearchInput) -> Arc<SearchOutcome> {
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
        let budget = self
            .config
            .budgets
            .collection_budget(input.deadline_at, input.now_ms);
        let jobs = plan_jobs(
            &self.config,
            meta,
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

    /// Uma passada do pipeline sobre um lote (resposta ou tardio).
    ///
    /// TUDO aqui é síncrono: o `DebridCheck` bloqueia no adaptador
    /// (`AdapterDebridCheck`), exatamente como o `applyDebrid` do TS. O
    /// `LatestWriter` decide SE esta versão commita (fase/revisão), e o
    /// `commit_decision` do núcleo decide O QUE gravar e com que TTL.
    #[allow(clippy::too_many_arguments)]
    fn finish(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        writer: &LatestWriter,
        phase: u64,
        items: &[RawItem],
        partial: bool,
        deadline_at: Option<i64>,
    ) -> FinishValue {
        let ctx = self.build_context(input, meta);
        let opts = build_options_from(&input.options, &self.config.build);
        let debrid_ctx = self.debrid_context(input, deadline_at);
        let signer = self.resolve_signer(input, meta);
        let store = self.store.clone();
        let key = input.key.clone();
        let now = input.now_ms;
        let shadow = self.shadow_mode;
        let (value, _commit) = writer.run(
            phase,
            || {
                // Sombra: nunca pergunta ao debrid (nem via fábrica injetada).
                let mut check: Box<dyn crate::list_builder::DebridCheck + Send> = if shadow {
                    Box::new(NoDebridCheck)
                } else {
                    self.debrid.make(&debrid_ctx)
                };
                let built =
                    build_stream_list(items, &ctx, &opts, &mut *check, &self.config.display);
                finish_value(
                    built,
                    meta,
                    partial,
                    &debrid_ctx,
                    &signer,
                    &self.config,
                    self.config.trace_enabled,
                    now,
                )
            },
            |value: &FinishValue| !value.entry.streams.is_empty(),
            |value: &FinishValue| {
                if shadow {
                    return;
                }
                if value.commit_write {
                    let entry = to_cacheable_entry(&value.entry);
                    store.set(&key, &entry, value.commit_ttl.max(0) as u64, as_ms(now));
                }
            },
        );
        value
    }

    fn build_context(&self, input: &SearchInput, meta: &SearchMeta) -> BuildContext {
        let service = str_of(&input.options, "debridService");
        let api_key = str_of(&input.options, "debridApiKey");
        BuildContext {
            names: meta.names.clone(),
            year: meta.year_text(),
            alt_year: meta.alt_year.clone(),
            multi_work_root: meta.multi_work_root.clone(),
            season: meta.season,
            episode: meta.episode,
            is_demo: meta.is_demo,
            debrid_available: !service.is_empty() && !api_key.is_empty(),
            debrid_cache_check_honest: adom_core::cache_check_honest(&service),
            debrid_has_key: !api_key.is_empty(),
            debrid_cached_only: bool_of(&input.options, "debridCachedOnly"),
            // Data de estreia do episódio: o parser de data fica para a fatia
            // seguinte (ver `meta.rs`); sem ela a guarda de pré-air não roda.
            episode_aired_at_ms: None,
            episode_counts: meta.episode_counts.clone(),
            first_seen_ms: HashMap::new(),
            executable_bases: Vec::new(),
            now_ms: input.now_ms,
        }
    }

    fn debrid_context(&self, input: &SearchInput, deadline_at: Option<i64>) -> DebridContext {
        DebridContext {
            service: str_of(&input.options, "debridService"),
            api_key: str_of(&input.options, "debridApiKey"),
            encoded: Some(encoded_for_internal(input.encoded.as_deref())),
            deadline_at,
        }
    }

    fn resolve_signer(&self, input: &SearchInput, meta: &SearchMeta) -> ResolveSigner {
        let api_key = str_of(&input.options, "debridApiKey");
        ResolveSigner {
            prefix: input.prefix.clone(),
            // `resolveSecret || debridApiKey || ''` (sign.ts:15-17).
            secret: if self.config.resolve_secret.is_empty() {
                api_key
            } else {
                self.config.resolve_secret.clone()
            },
            season: meta.season,
            episode: meta.episode,
            imdb_id: Some(meta.imdb_id.clone()).filter(|id| !id.is_empty()),
            work_hint: None,
        }
    }

    // ── Fila tardia ────────────────────────────────────────────────────────

    fn tail_plan(
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
    async fn run_tail(
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
        let before = partial_items.len();
        let mut full = match completion {
            Some(handle) => handle.await.unwrap_or_else(|_| partial_items.clone()),
            None => partial_items,
        };
        let mut last = first;
        if full.len() > before {
            // Fontes lentas chegaram: reconstrói com o lote COMPLETO e regrava
            // (fase atual, revisão mais nova).
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

    // ── Resposta ───────────────────────────────────────────────────────────

    fn respond_entry(&self, entry: &StreamsEntry, req: &StreamRequest) -> StreamResponse {
        StreamResponse {
            streams: entry_streams(entry, req),
            cache_max_age: cache_max_age_for_entry(entry, &self.config),
        }
    }

    fn respond_outcome(&self, outcome: &SearchOutcome, req: &StreamRequest) -> StreamResponse {
        let mut streams = entry_streams(&outcome.entry, req);
        if streams.is_empty() && (outcome.collect_failed || outcome.partial) {
            // Lista vazia por falha de coleta é "sem resposta", não "sem
            // resultado": mesmo texto do corte externo.
            if outcome.collect_failed {
                streams = notice_streams(req, NOTICE_SEARCHING);
            }
        }
        StreamResponse {
            streams,
            cache_max_age: outcome.cache_max_age,
        }
    }

    fn respond_notice(&self, req: &StreamRequest, text: &str) -> StreamResponse {
        StreamResponse {
            streams: notice_streams(req, text),
            cache_max_age: 0,
        }
    }

    // ── Identidade ─────────────────────────────────────────────────────────

    /// Config do usuário: overlay do segmento sobre os defaults do operador.
    /// Sem segmento, os defaults; config inválida cai nos defaults (o 404 de
    /// config inválida é do roteador HTTP, não deste crate).
    fn resolve_options(&self, encoded: &Option<String>) -> Value {
        match encoded {
            Some(segment) => adom_core::decode_config(
                segment,
                &self.config.defaults,
                &self.config.resolve_secret,
            )
            .unwrap_or_else(|| self.config.defaults.clone()),
            None => self.config.defaults.clone(),
        }
    }

    /// Opções que entram na CHAVE: as do usuário + `resolveUncached` do
    /// operador (muda a `url` de cada stream). Nunca o host.
    fn key_options(&self, options: &Value) -> Value {
        let mut out = options.clone();
        if let Some(map) = out.as_object_mut() {
            map.insert(
                "resolveUncached".to_string(),
                Value::Bool(self.config.resolve_uncached),
            );
        }
        out
    }
}

// ── Peças puras ─────────────────────────────────────────────────────────────

fn empty_response() -> StreamResponse {
    StreamResponse {
        streams: Vec::new(),
        cache_max_age: 0,
    }
}

fn entry_streams(entry: &StreamsEntry, req: &StreamRequest) -> Vec<StreamItem> {
    let built: Vec<BuiltStream> = entry
        .streams
        .iter()
        .map(|item| BuiltStream {
            item: item.clone(),
            is_br: false,
            // A marca de aviso é da ENTRADA (o cache não guarda `notice` por
            // item); `applyNoticeOrigin` a converte em `externalUrl`.
            notice: entry.notice,
            cached: false,
            info_hash: None,
            dubbed: false,
            multi_work_admitted: false,
        })
        .collect();
    apply_notice_origin(&built, req.origin.as_deref(), &req.prefix())
}

fn notice_streams(req: &StreamRequest, text: &str) -> Vec<StreamItem> {
    let built = vec![BuiltStream {
        item: StreamItem {
            name: Some(text.to_string()),
            ..StreamItem::default()
        },
        is_br: false,
        notice: true,
        cached: false,
        info_hash: None,
        dubbed: false,
        multi_work_admitted: false,
    }];
    apply_notice_origin(&built, req.origin.as_deref(), &req.prefix())
}

/// Fim da passada: entrada gravável + fatos da resposta.
#[allow(clippy::too_many_arguments)]
fn finish_value(
    built: crate::list_builder::BuiltList,
    meta: &SearchMeta,
    partial: bool,
    debrid: &DebridContext,
    signer: &ResolveSigner,
    config: &OrchestratorConfig,
    trace_enabled: bool,
    now_ms: i64,
) -> FinishValue {
    // A URL de play nasce AQUI (prefixo/segredo são da requisição) e RELATIVA:
    // o host entra em `applyNoticeOrigin`, nunca no cache. O item resolvido
    // perde `infoHash`/`sources`, como no Node.
    let mut built = built;
    let signer = ResolveSigner {
        work_hint: built.work_hint.clone(),
        ..signer.clone()
    };
    for stream in &mut built.streams {
        if !stream.cached {
            continue;
        }
        let Some(hash) = stream.info_hash.clone().filter(|h| !h.is_empty()) else {
            continue;
        };
        let url = signer.url(&hash, stream.dubbed, stream.multi_work_admitted);
        stream.item.url = Some(url);
        stream.item.info_hash = None;
        stream.item.sources = None;
    }

    // Ledger: o funil do build vira `stages`; `final` fecha o tamanho entregue.
    let mut trace = new_trace(now_ms as f64, trace_enabled);
    trace::record_build_stages(&mut trace, &built.funnel);
    trace::finish_trace(&mut trace, built.streams.len(), now_ms as f64);
    let trace_value = trace::trace_to_cache_value(trace.as_ref());

    let streams: Vec<StreamItem> = built.streams.iter().map(|s| s.item.clone()).collect();
    let notice = !built.streams.is_empty() && built.streams.iter().all(|s| s.notice);
    // Sem debrid ativo ninguém perguntou — e isso NÃO é "não tem" (o TS nem
    // chama o applyDebrid: `known` fica undefined → conhecido).
    let debrid_known = if debrid.is_active() {
        built.debrid_known && !built.needs_debrid_refresh
    } else {
        true
    };
    let needs_debrid_refresh = debrid.is_active() && built.needs_debrid_refresh;
    let mut entry = StreamsEntry {
        streams,
        partial: partial || built.fallback,
        debrid_known: Some(debrid_known),
        fallback: built.fallback,
        notice,
        trace: trace_value,
        search_meta: Some(meta.search_meta_json()),
    };
    let decision = commit_decision(&CommitFacts {
        playable: has_playable_stream(&entry.streams),
        partial: entry.partial,
        debrid_known: entry.debrid_known,
        needs_debrid_refresh,
        has_fallback: built.fallback,
        cache_ttl: config.cache_ttl,
        fallback_streams_ttl: config.fallback_streams_ttl,
    });
    entry.partial = decision.partial;
    entry.debrid_known = Some(decision.debrid_known);
    // TTL <= 0 é cache desligado: não grava (mesma leitura do ramo da reserva).
    let commit_write = decision.write && decision.ttl > 0;
    let partial_entry = entry.partial;
    FinishValue {
        entry,
        entered: built.entered_raw,
        filtered: built.filtered_raw,
        partial: partial_entry,
        debrid_known,
        needs_debrid_refresh,
        commit_write,
        commit_ttl: decision.ttl,
    }
}

/// Lote do índice de releases (`entered`/`survivors` do filtro de título).
fn release_entry(meta: &SearchMeta, entered: &[RawItem], survivors: &[RawItem]) -> ReleaseEntry {
    ReleaseEntry {
        imdb: meta.imdb_id.clone(),
        season: meta.season,
        episode: meta.episode,
        items: survivors.iter().map(RawItem::to_wire).collect(),
        entered: Some(entered.iter().map(RawItem::to_wire).collect()),
        survivors: Some(survivors.iter().map(RawItem::to_wire).collect()),
        source: None,
    }
}

/// `cacheMaxAge` de uma entrada do cache (o `streamsNeedRevalidation` +
/// `onlyNotice` do handler): lista vazia, parcial, aviso ou debrid não
/// confiável NÃO pode ser cacheada pelo cliente.
fn cache_max_age_for_entry(entry: &StreamsEntry, config: &OrchestratorConfig) -> u32 {
    let revalidation = entry.streams.is_empty()
        || entry.partial
        || entry.notice
        || entry.debrid_known == Some(false);
    if revalidation {
        0
    } else {
        config.cache_ttl.max(0) as u32
    }
}

fn cache_max_age_for_finish(
    value: &FinishValue,
    collect_failed: bool,
    config: &OrchestratorConfig,
) -> u32 {
    let revalidation = value.entry.streams.is_empty()
        || value.partial
        || value.entry.notice
        || !value.debrid_known
        || value.needs_debrid_refresh
        || collect_failed;
    if revalidation {
        0
    } else {
        config.cache_ttl.max(0) as u32
    }
}

fn str_of(options: &Value, key: &str) -> String {
    options
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn bool_of(options: &Value, key: &str) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn is_demo(options: &Value) -> bool {
    options
        .get("providers")
        .and_then(Value::as_array)
        .map(|list| list.iter().any(|p| p.as_str() == Some("demo")))
        .unwrap_or(false)
}
