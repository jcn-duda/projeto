//! Collect opt-in via `adom_sources::JackettClient` (`SOURCES_RUST=jackett`).
//!
//! Default OFF: produção continua em [`super::NodeCollector`]
//! (`POST /internal/search/collect`). Prowlarr tem collector irmão
//! (`SOURCES_RUST=prowlarr` / `torrentio` / `bludv` / `mico`); exclusão mútua
//! em [`super::sources_rust`].
//!
//! Guardrail do Maestro: varredura **inline** (`sweep:true` no plano) usa
//! `record_status:false` e **não** `ignore_breaker`; a varredura **tardia**
//! (`CollectJob.late_sweep`) usa `ignore_breaker:true`. Fail-open: falha de
//! rede/indexer → lote vazio, nunca `Err` que derrube a busca.

use std::future::Future;
use std::pin::Pin;

use adom_core::{live_indexers, plan_jackett_queries, pt_sweep_indexers};
use adom_sources::{JackettClient, JackettMediaType, JackettRawItem, SearchOptions};

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::sources_rust::sources_rust_includes;
use crate::raw_item::RawItem;

/// Defaults alinhados a `src/config/jackett.ts` (`JACKETT_INDEX_ONLY_INDEXERS`).
fn default_index_only_indexers() -> Vec<String> {
    split_csv(
        "redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann,magnetdownload,1337x",
    )
}

fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// `SOURCES_RUST` contém o token `jackett` (CSV, case-insensitive).
pub fn sources_rust_includes_jackett() -> bool {
    sources_rust_includes("jackett")
}

/// Monta o collector só quando o env pediu Jackett nativo. Falha de boot do
/// cliente → `None` + log (degrada para o caller usar NodeCollector).
pub fn try_jackett_collector_from_env() -> Option<JackettCollector> {
    if !sources_rust_includes_jackett() {
        return None;
    }
    match JackettCollector::from_env() {
        Ok(c) => Some(c),
        Err(err) => {
            eprintln!("[search] SOURCES_RUST=jackett mas JackettClient falhou: {err}");
            None
        }
    }
}

/// Uma consulta Torznab já filtrada por `task_scope` / late-sweep.
#[derive(Debug, Clone)]
pub struct PlannedJackettSearch {
    pub query: String,
    pub indexers: Vec<String>,
    pub options: SearchOptions,
    pub priority: bool,
}

/// Expande um [`CollectJob`] nas consultas Jackett (puro — sem HTTP).
///
/// - `late_sweep`: só globais × `sweep_query`, com `ignore_breaker`.
/// - demais: `plan_jackett_queries` filtrado por `scope`; sweep inline sem
///   `ignore_breaker`.
pub fn plan_jackett_searches(
    job: &CollectJob,
    selected_indexers: &[String],
    pt_br_indexers: &[String],
    isolate_indexers: &[String],
    index_only_indexers: &[String],
) -> Vec<PlannedJackettSearch> {
    if job.late_sweep {
        let Some(sweep) = job.sweep_query.as_deref().filter(|s| !s.is_empty()) else {
            return Vec::new();
        };
        let live = live_indexers(selected_indexers, index_only_indexers, &[]);
        let targets = pt_sweep_indexers(&live, pt_br_indexers, index_only_indexers);
        if targets.is_empty() {
            return Vec::new();
        }
        return vec![PlannedJackettSearch {
            query: sweep.to_string(),
            indexers: targets,
            options: SearchOptions {
                record_status: Some(false),
                ignore_breaker: true,
                original_query: job.original_query.clone(),
                ..SearchOptions::default()
            },
            priority: false,
        }];
    }

    let live = live_indexers(selected_indexers, index_only_indexers, &[]);
    // Seleção só de index-only: nada no caminho da resposta (mesmo contrato TS).
    if !selected_indexers.is_empty() && live.is_empty() {
        return Vec::new();
    }
    // Sem seleção → agregado `/all` (lista vazia de indexers no cliente).
    if live.is_empty() {
        return vec![PlannedJackettSearch {
            query: job.query.clone(),
            indexers: Vec::new(),
            options: SearchOptions {
                original_query: job.original_query.clone(),
                multi_work_query: job.multi_work_query.clone(),
                ..SearchOptions::default()
            },
            priority: false,
        }];
    }

    let plan = plan_jackett_queries(
        &job.query,
        job.pt_query.as_deref(),
        &live,
        pt_br_indexers,
        isolate_indexers,
        job.sweep_query.as_deref(),
        job.original_query.as_deref(),
        job.multi_work_query.as_deref(),
    );

    let mut out = Vec::new();
    for planned in plan {
        let priority = planned
            .indexers
            .iter()
            .any(|indexer| pt_br_indexers.iter().any(|br| br == indexer));
        match job.scope {
            TaskScope::Priority if !priority => continue,
            TaskScope::Nonpriority if priority => continue,
            _ => {}
        }
        let inline_sweep = planned.sweep == Some(true);
        out.push(PlannedJackettSearch {
            query: planned.query,
            indexers: planned.indexers,
            options: SearchOptions {
                // Inline: não pinta card / não alimenta breaker; NÃO ignora.
                record_status: if inline_sweep { Some(false) } else { None },
                ignore_breaker: false,
                fallback_query: planned.fallback,
                variant_query: planned.variant,
                franchise_query: planned.franchise,
                multi_work_query: planned.multi_work,
                original_query: planned.original,
                ..SearchOptions::default()
            },
            priority,
        });
    }
    out
}

/// Collector que fala Torznab direto (sem POST `/internal/search/collect`).
pub struct JackettCollector {
    client: JackettClient,
    selected_indexers: Vec<String>,
    pt_br_indexers: Vec<String>,
    isolate_indexers: Vec<String>,
    index_only_indexers: Vec<String>,
}

impl JackettCollector {
    pub fn new(client: JackettClient) -> Self {
        let cfg = client.config();
        let index_only = std::env::var("JACKETT_INDEX_ONLY_INDEXERS")
            .ok()
            .map(|raw| split_csv(&raw))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(default_index_only_indexers);
        Self {
            selected_indexers: cfg.indexers.clone(),
            pt_br_indexers: cfg.pt_br_indexers.clone(),
            isolate_indexers: cfg.slow_indexers.clone(),
            index_only_indexers: index_only,
            client,
        }
    }

    pub fn from_env() -> Result<Self, String> {
        Ok(Self::new(JackettClient::from_env()?))
    }

    /// Listas do plano vindas do orquestrador (quando o caller já as povoou).
    pub fn with_plan(
        mut self,
        selected: Vec<String>,
        pt_br: Vec<String>,
        isolate: Vec<String>,
        index_only: Vec<String>,
    ) -> Self {
        if !selected.is_empty() {
            self.selected_indexers = selected;
        }
        if !pt_br.is_empty() {
            self.pt_br_indexers = pt_br;
        }
        if !isolate.is_empty() {
            self.isolate_indexers = isolate;
        }
        if !index_only.is_empty() {
            self.index_only_indexers = index_only;
        }
        self
    }

    pub fn client(&self) -> &JackettClient {
        &self.client
    }
}

impl Collector for JackettCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            let media = JackettMediaType::parse(&job.kind);
            let planned = plan_jackett_searches(
                &job,
                &self.selected_indexers,
                &self.pt_br_indexers,
                &self.isolate_indexers,
                &self.index_only_indexers,
            );
            if planned.is_empty() {
                return Ok(CollectBatch::default());
            }

            let mut handles = Vec::with_capacity(planned.len());
            for step in planned {
                let client = self.client.clone();
                handles.push(tokio::spawn(async move {
                    client
                        .search(&step.query, media, &step.indexers, &step.options)
                        .await
                }));
            }

            let mut items = Vec::new();
            for handle in handles {
                match handle.await {
                    Ok(batch) => items.extend(batch.into_iter().map(raw_from_jackett)),
                    Err(err) => {
                        // JoinError: engole (fail-open), nunca propaga.
                        eprintln!("[search] jackett collect: tarefa abortada: {err}");
                    }
                }
            }
            Ok(CollectBatch {
                items,
                partial: false,
            })
        })
    }
}

fn raw_from_jackett(item: JackettRawItem) -> RawItem {
    let sources = item
        .tracker
        .as_deref()
        .filter(|t| !t.is_empty())
        .map(|t| vec![format!("tracker:{t}")])
        .unwrap_or_default();
    RawItem {
        title: Some(item.title).filter(|t| !t.is_empty()),
        magnet: item.magnet,
        info_hash: item.info_hash,
        published_at: item.published_at.map(|ms| ms as f64),
        seeders: item.seeders,
        size_bytes: item.size,
        indexer: Some(item.indexer).filter(|s| !s.is_empty()),
        sources,
        is_br: item.is_br,
        ..RawItem::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::collect::CollectJob;
    use serde_json::json;

    fn base_job() -> CollectJob {
        CollectJob {
            encoded: "e30".into(),
            scope: TaskScope::All,
            kind: "movie".into(),
            imdb_id: "tt0133093".into(),
            season: None,
            episode: None,
            year: Some(json!(1999)),
            names: vec!["The Matrix".into()],
            query: "The Matrix 1999".into(),
            pt_query: Some("Matrix 1999".into()),
            sweep_query: Some("Matrix".into()),
            original_query: None,
            multi_work_query: None,
            priority: false,
            deadline_at: 1_700_000_000_000,
            late_sweep: false,
        }
    }

    #[test]
    fn inline_sweep_nao_ignora_breaker() {
        let job = CollectJob {
            scope: TaskScope::Nonpriority,
            ..base_job()
        };
        let planned = plan_jackett_searches(
            &job,
            &["yts".into(), "bludv".into()],
            &["bludv".into()],
            &["bludv".into()],
            &[],
        );
        let sweeps: Vec<_> = planned
            .iter()
            .filter(|p| p.options.record_status == Some(false))
            .collect();
        assert!(
            !sweeps.is_empty(),
            "varredura inline deve existir quando sweep_query ≠ query"
        );
        for s in sweeps {
            assert!(!s.options.ignore_breaker, "inline NÃO usa ignore_breaker");
            assert!(!s.priority, "varredura é nos globais");
        }
        let mains: Vec<_> = planned
            .iter()
            .filter(|p| p.options.record_status.is_none())
            .collect();
        assert!(!mains.is_empty());
        for m in mains {
            assert!(!m.options.ignore_breaker);
        }
    }

    #[test]
    fn late_sweep_usa_ignore_breaker() {
        let job = CollectJob {
            late_sweep: true,
            scope: TaskScope::All,
            ..base_job()
        };
        let planned = plan_jackett_searches(
            &job,
            &["yts".into(), "bludv".into(), "1337x".into()],
            &["bludv".into()],
            &["bludv".into()],
            &["1337x".into()],
        );
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].query, "Matrix");
        assert_eq!(planned[0].indexers, vec!["yts".to_string()]);
        assert!(planned[0].options.ignore_breaker);
        assert_eq!(planned[0].options.record_status, Some(false));
    }

    #[test]
    fn priority_scope_so_br() {
        let job = CollectJob {
            scope: TaskScope::Priority,
            sweep_query: None,
            ..base_job()
        };
        let planned = plan_jackett_searches(
            &job,
            &["yts".into(), "bludv".into()],
            &["bludv".into()],
            &["bludv".into()],
            &[],
        );
        assert!(!planned.is_empty());
        assert!(planned.iter().all(|p| p.priority));
        assert!(planned.iter().all(|p| p.indexers == ["bludv"]));
    }

    #[test]
    fn index_only_sozinho_nao_consulta() {
        let job = base_job();
        let planned = plan_jackett_searches(&job, &["1337x".into()], &[], &[], &["1337x".into()]);
        assert!(planned.is_empty());
    }
}
