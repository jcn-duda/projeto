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
}

/// Lote devolvido por uma tarefa.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CollectBatch {
    pub items: Vec<RawItem>,
    /// A própria coleta do Node parou por prazo (`!done` no `collectRaw`).
    pub partial: bool,
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
    })
}

/// Produção: `POST /internal/search/collect` (loopback + token + `encoded`).
pub struct NodeCollector {
    routes: Arc<dyn InternalRoutes>,
}

impl NodeCollector {
    pub fn new(routes: Arc<dyn InternalRoutes>) -> Self {
        NodeCollector { routes }
    }
}

impl Collector for NodeCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            let response = self
                .routes
                .collect(collect_request_from_job(job))
                .await?;
            Ok(CollectBatch {
                items: response
                    .items
                    .iter()
                    .map(crate::raw_item::raw_item_from_value)
                    .collect(),
                partial: response.partial,
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::config::OrchestratorConfig;
    use serde_json::json;

    fn meta_movie() -> SearchMeta {
        SearchMeta {
            imdb_id: "tt0133093".into(),
            name: "The Matrix".into(),
            names: vec!["The Matrix".into()],
            query: "The Matrix 1999".into(),
            year: json!(1999),
            ..SearchMeta::default()
        }
    }

    #[test]
    fn plan_jobs_leva_type_stremio_nao_rotulo_do_grupo() {
        let config = OrchestratorConfig::default();
        let jobs = plan_jobs(&config, &meta_movie(), "movie", Some("e30"), 1_700_000_000_000);
        assert!(!jobs.is_empty());
        for job in &jobs {
            assert_eq!(job.kind, "movie", "kind do job é movie|series, não priority/global");
            let body = serde_json::to_value(collect_request_from_job(job.clone())).unwrap();
            assert_eq!(body["type"], json!("movie"));
            assert_ne!(body["type"], json!("priority"));
            assert_ne!(body["type"], json!("global"));
            assert!(matches!(
                body["task_scope"].as_str(),
                Some("all") | Some("priority") | Some("nonpriority") | None
            ));
        }
    }

    #[test]
    fn sweep_job_tambem_manda_movie_ou_series() {
        let mut config = OrchestratorConfig::default();
        config.sweep_enabled = true;
        let mut meta = meta_movie();
        meta.sweep_query = Some("Matrix".into());
        let job = sweep_job(&config, &meta, "series", None, 1_700_000_000_000).expect("sweep");
        assert_eq!(job.kind, "series");
        let body = serde_json::to_value(collect_request_from_job(job)).unwrap();
        assert_eq!(body["type"], json!("series"));
        assert_eq!(body["task_scope"], json!("all"));
    }
}
