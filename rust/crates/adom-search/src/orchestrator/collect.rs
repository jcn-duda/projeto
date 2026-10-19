//! Coleta: o PLANO (quem consulta o quê) e a trait que executa cada tarefa.
//!
//! O plano é a parte pura e mora no núcleo (`adom_core::search_plan`); aqui só
//! se decide a TOPOLOGIA que a janela consome:
//!
//! - **grupo BR/prioritário separado dos globais** — é a tarefa que ganha a
//!   graça `BR_PARTIAL_GRACE_MS` quando só os globais chegaram (Disclosure Day);
//! - **`task_scope`** é o seletor que a rota interna do Node entende
//!   (`priority`/`nonpriority`/`all`), então uma tarefa por grupo espelha o
//!   `collectRaw` sem repetir a consulta;
//! - **prazo ABSOLUTO** (`deadline_at`, epoch ms) é o da RESPOSTA; quem subtrai
//!   a reserva de debrid é a janela (`collection_budget`), não o job. Passar a
//!   sobra já descontada faria o Node descontar de novo.
//!
//! A coleta em si é INJETADA ([`Collector`]): produção fala
//! `POST /internal/search/collect`; teste usa stub. Falha de qualquer tarefa
//! vira lote vazio + erro observado — nunca derruba a busca.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use adom_core::{live_indexers, plan_jackett_queries};
use serde_json::Value;

use crate::internal_types::{CollectRequest, TaskScope};
use crate::orchestrator::internal_routes::InternalRoutes;
use crate::orchestrator::live_state::LiveBatchState;
use crate::orchestrator::meta::SearchMeta;
use crate::raw_item::RawItem;

/// Uma tarefa de coleta com o prazo absoluto da resposta.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectJob {
    pub encoded: String,
    pub scope: TaskScope,
    /// Tipo Stremio (`movie` | `series`) — vai no campo JSON `type` da rota.
    /// NÃO é o rótulo do grupo (priority/global): isso é `scope`/`priority`.
    pub kind: String,
    pub imdb_id: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub year: Option<Value>,
    pub names: Vec<String>,
    pub query: String,
    pub pt_query: Option<String>,
    pub sweep_query: Option<String>,
    pub original_query: Option<String>,
    pub multi_work_query: Option<String>,
    /// `true` = grupo BR: entra na graça da janela, não na fatia global.
    pub priority: bool,
    /// Epoch ms do prazo da RESPOSTA.
    pub deadline_at: i64,
    /// Passe tardio da varredura pt-BR (`TailJob::PtSweep`): `ignore_breaker`
    /// liga; a varredura **inline** (task `sweep:true` no plano da coleta
    /// principal) NÃO — não misturar os dois caminhos.
    pub late_sweep: bool,
}

/// Lote devolvido por uma tarefa.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollectBatch {
    pub items: Vec<RawItem>,
    /// A própria coleta do Node parou por prazo (`!done` no `collectRaw`).
    pub partial: bool,
    /// Estado vivo POR indexer do `collectRaw` (falha/pendente/vazio/agregado,
    /// `live.snapshot()` da rota interna). `None` = fonte sem contrato vivo
    /// (collector nativo, Node antigo): ausência NUNCA prova sucesso — quem
    /// consome cai na régua antiga, nunca em "todos responderam".
    pub live: Option<LiveBatchState>,
}

/// Executa UMA tarefa de coleta.
pub trait Collector: Send + Sync {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>>;
}

/// Monta as tarefas a partir do plano do núcleo.
///
/// Sem seleção de indexer (instalação sem `ji`), o plano não gera tarefa — mas
/// o `jackett.search` do Node cai no agregado `/all` com a config do operador.
/// Nesse caso a janela recebe UMA tarefa `all`, como o TS.
///
/// `kind` é o tipo Stremio (`movie`|`series`) — o Node valida `body.type`.
pub fn plan_jobs(
    config: &crate::orchestrator::config::OrchestratorConfig,
    meta: &SearchMeta,
    kind: &str,
    encoded: Option<&str>,
    deadline_at: i64,
) -> Vec<CollectJob> {
    // Index-only ficam fora do caminho da resposta (colhem em fundo no Node).
    let selected = live_indexers(&config.selected_indexers, &config.index_only_indexers, &[]);
    let sweep_query = if config.sweep_enabled {
        meta.sweep_query.clone()
    } else {
        None
    };
    let base = CollectJob {
        encoded: crate::request::encoded_for_internal(encoded),
        scope: TaskScope::All,
        kind: kind.to_string(),
        imdb_id: meta.imdb_id.clone(),
        season: meta.season,
        episode: meta.episode,
        year: Some(meta.year.clone()).filter(|v| !v.is_null()),
        names: meta.names.clone(),
        query: meta.query.clone(),
        pt_query: meta.pt_query.clone(),
        sweep_query: None,
        original_query: meta.original_query.clone(),
        multi_work_query: meta.multi_work_query.clone(),
        priority: false,
        deadline_at,
        late_sweep: false,
    };
    if selected.is_empty() {
        return vec![CollectJob { ..base }];
    }
    let plan = plan_jackett_queries(
        &meta.query,
        meta.pt_query.as_deref(),
        &selected,
        &config.pt_br_indexers,
        &config.isolate_indexers,
        sweep_query.as_deref(),
        meta.original_query.as_deref(),
        meta.multi_work_query.as_deref(),
    );
    // A varredura é a tarefa marcada ESTRUTURALMENTE (`sweep:true`), nunca
    // inferida por igualdade de query — a tarefa BR isolada pode ter a mesma.
    let is_priority = |task: &adom_core::SearchPlanTask| {
        task.indexers
            .iter()
            .any(|indexer| config.pt_br_indexers.contains(indexer))
    };
    let has_global = plan
        .iter()
        .any(|t| !t.sweep.unwrap_or(false) && !is_priority(t));
    let has_priority = plan
        .iter()
        .any(|t| !t.sweep.unwrap_or(false) && is_priority(t));

    let mut jobs = Vec::new();
    if has_priority {
        jobs.push(CollectJob {
            scope: TaskScope::Priority,
            priority: true,
            ..base.clone()
        });
    }
    if has_global || !has_priority {
        jobs.push(CollectJob {
            scope: if has_priority {
                TaskScope::Nonpriority
            } else {
                TaskScope::All
            },
            // A query da varredura só vale onde há global para consultar.
            sweep_query: if has_global { sweep_query } else { None },
            ..base
        });
    }
    jobs
}

/// Tarefa ÚNICA do passe tardio: a varredura pt-BR nos globais.
///
/// A varredura inline já entrou no job de coleta (`sweep_query`); esta só roda
/// quando a coleta foi PARCIAL — o resto dos globais não estava no balde da
/// resposta. `priority=false`: a varredura nunca é a fonte BR.
///
/// `kind` é o tipo Stremio (`movie`|`series`) — igual ao da coleta principal.
pub fn sweep_job(
    config: &crate::orchestrator::config::OrchestratorConfig,
    meta: &SearchMeta,
    kind: &str,
    encoded: Option<&str>,
    deadline_at: i64,
) -> Option<CollectJob> {
    let sweep_query = meta.sweep_query.clone().filter(|_| config.sweep_enabled)?;
    Some(CollectJob {
        encoded: crate::request::encoded_for_internal(encoded),
        scope: TaskScope::All,
        kind: kind.to_string(),
        imdb_id: meta.imdb_id.clone(),
        season: meta.season,
        episode: meta.episode,
        year: Some(meta.year.clone()).filter(|v| !v.is_null()),
        names: meta.names.clone(),
        query: meta.query.clone(),
        pt_query: meta.pt_query.clone(),
        sweep_query: Some(sweep_query),
        original_query: meta.original_query.clone(),
        multi_work_query: meta.multi_work_query.clone(),
        priority: false,
        deadline_at,
        late_sweep: true,
    })
}

/// Produção: `POST /internal/search/collect` (loopback + token + `encoded`).
pub struct NodeCollector {
    routes: Arc<dyn InternalRoutes>,
    /// Fontes que o Node deve PULAR porque o coletor nativo já as cobre
    /// (`SOURCES_RUST`). Vai no corpo como `skip_sources`.
    skip_sources: Vec<String>,
}

impl NodeCollector {
    pub fn new(routes: Arc<dyn InternalRoutes>) -> Self {
        NodeCollector {
            routes,
            skip_sources: Vec::new(),
        }
    }

    /// Fontes migradas para Rust: o Node não as consulta de novo.
    pub fn with_skip_sources(mut self, sources: Vec<String>) -> Self {
        self.skip_sources = sources;
        self
    }
}

impl Collector for NodeCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            let mut request = collect_request_from_job(job);
            request.skip_sources = self.skip_sources.clone();
            let response = self.routes.collect(request).await?;
            Ok(CollectBatch {
                items: response
                    .items
                    .iter()
                    .map(crate::raw_item::raw_item_from_value)
                    .collect(),
                partial: response.partial,
                // Contrato vivo completo do Node: failed, pending, empty e o
                // agregado `all` — não só o vazio suspeito. `None` (rota sem
                // `live`) segue sem provar nada.
                live: response.live.as_ref().map(LiveBatchState::from_wire),
            })
        })
    }
}

/// Corpo de `POST /internal/search/collect` a partir do job.
///
/// Isolado para o teste exercer o contrato sem HTTP: `type` = movie|series,
/// `task_scope` = all|priority|nonpriority (não misturar).
pub fn collect_request_from_job(job: CollectJob) -> CollectRequest {
    CollectRequest {
        encoded: job.encoded,
        query: job.query,
        media_type: job.kind,
        imdb: job.imdb_id,
        deadline_at: job.deadline_at,
        task_scope: Some(job.scope),
        pt_query: job.pt_query,
        season: job.season,
        episode: job.episode,
        year: job.year,
        names: Some(job.names).filter(|names| !names.is_empty()),
        sweep_query: job.sweep_query,
        original_query: job.original_query,
        multi_work_query: job.multi_work_query,
        skip_sources: Vec::new(),
    }
}

#[cfg(test)]
#[path = "collect_tests.rs"]
mod tests;
