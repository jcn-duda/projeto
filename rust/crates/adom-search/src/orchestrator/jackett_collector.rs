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
use adom_sources::{JackettClient, JackettMediaType, JackettRawItem, QueryOutcome, SearchOptions};

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{jackett_only, CollectBatch, CollectJob, Collector};
use crate::orchestrator::jackett_live::{
    live_state_from_outcomes, live_state_from_outcomes_shadow,
};
use crate::orchestrator::sources_rust::sources_rust_includes;
use crate::raw_item::RawItem;

#[path = "jackett_collector_env.rs"]
mod env;
use env::{
    default_index_only_indexers, default_live_exempt_indexers, parse_title_precision_tail_cut,
    split_csv,
};

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
    /// `false` = sweep (inline ou tardio): fora do live da sombra.
    pub primary: bool,
}

/// Modo sombra: ignora o breaker (não pula fonte já aberta) e não registra
/// status/breaker. O live da sombra é montado sem o filtro de `record_status`.
fn shadowed(mut options: SearchOptions, shadow: bool) -> SearchOptions {
    if shadow {
        options.ignore_breaker = true;
        options.record_status = Some(false);
    }
    options
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
    exempt_indexers: &[String],
    shadow: bool,
) -> Vec<PlannedJackettSearch> {
    if job.late_sweep {
        let Some(sweep) = job.sweep_query.as_deref().filter(|s| !s.is_empty()) else {
            return Vec::new();
        };
        let live = live_indexers(
            &jackett_only(selected_indexers),
            index_only_indexers,
            exempt_indexers,
        );
        let targets = pt_sweep_indexers(&live, pt_br_indexers, index_only_indexers);
        if targets.is_empty() {
            return Vec::new();
        }
        return vec![PlannedJackettSearch {
            query: sweep.to_string(),
            indexers: targets,
            options: shadowed(
                SearchOptions {
                    record_status: Some(false),
                    ignore_breaker: true,
                    original_query: job.original_query.clone(),
                    ..SearchOptions::default()
                },
                shadow,
            ),
            priority: false,
            primary: false,
        }];
    }

    // O card virtual `mico` convive no `ji` mas não é do Jackett: sai do plano
    // (o coletor nativo do Mico é quem o atende). Preservar a diferença entre
    // "sem seleção" (agregado `/all`) e "só o Mico" (nenhuma consulta) é o que
    // impede a seleção só-do-card de reabrir a lista inteira do operador.
    let selected_jackett = jackett_only(selected_indexers);
    let live = live_indexers(&selected_jackett, index_only_indexers, exempt_indexers);
    // Seleção só de index-only/Mico: nada no caminho da resposta (mesmo
    // contrato TS).
    if !selected_indexers.is_empty() && live.is_empty() {
        return Vec::new();
    }
    // Sem seleção → agregado `/all` (lista vazia de indexers no cliente).
    if live.is_empty() {
        return vec![PlannedJackettSearch {
            query: job.query.clone(),
            indexers: Vec::new(),
            options: shadowed(
                SearchOptions {
                    original_query: job.original_query.clone(),
                    multi_work_query: job.multi_work_query.clone(),
                    ..SearchOptions::default()
                },
                shadow,
            ),
            priority: false,
            primary: true,
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
            options: shadowed(
                SearchOptions {
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
                shadow,
            ),
            priority,
            primary: !inline_sweep,
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
    /// `JACKETT_LIVE_EXEMPT_INDEXERS` (default apachetorrent-cardigann).
    live_exempt_indexers: Vec<String>,
    /// Referência da sombra: sem breaker/status, live sem filtro.
    shadow: bool,
    /// `TITLE_PRECISION_TAIL_CUT` do processo (default true, como o Node).
    title_precision_tail_cut: bool,
}

impl JackettCollector {
    pub fn new(client: JackettClient) -> Self {
        let cfg = client.config();
        let index_only = std::env::var("JACKETT_INDEX_ONLY_INDEXERS")
            .ok()
            .map(|raw| split_csv(&raw))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(default_index_only_indexers);
        // `??` do Node: env PRESENTE (mesmo vazia) manda; ausente = default.
        let live_exempt = std::env::var("JACKETT_LIVE_EXEMPT_INDEXERS")
            .ok()
            .map(|raw| split_csv(&raw))
            .unwrap_or_else(default_live_exempt_indexers);
        Self {
            selected_indexers: cfg.indexers.clone(),
            pt_br_indexers: cfg.pt_br_indexers.clone(),
            isolate_indexers: cfg.slow_indexers.clone(),
            index_only_indexers: index_only,
            live_exempt_indexers: live_exempt,
            shadow: false,
            // Limitação: o collector é montado por env, não recebe o
            // `OrchestratorConfig`; se o processo Rust não tiver a env, o
            // default do Node (true) é usado.
            title_precision_tail_cut: std::env::var("TITLE_PRECISION_TAIL_CUT")
                .map(|value| parse_title_precision_tail_cut(&value))
                .unwrap_or(true),
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

    /// Sombra de fonte: `ignore_breaker` + `record_status:false` no plano;
    /// falhas não abrem/registram breaker e o live é comparado sem filtro.
    pub fn with_shadow(mut self, shadow: bool) -> Self {
        self.shadow = shadow;
        self
    }

    /// Piso de precisão de título (default true; o Node lê a mesma env).
    pub fn with_title_precision_tail_cut(mut self, enabled: bool) -> Self {
        self.title_precision_tail_cut = enabled;
        self
    }

    /// Exceção de presença ao vivo (`JACKETT_LIVE_EXEMPT_INDEXERS`).
    pub fn with_live_exempt_indexers(mut self, indexers: Vec<String>) -> Self {
        self.live_exempt_indexers = indexers;
        self
    }
}

impl Collector for JackettCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            // Seleção da REQUEST (`ji`): vence o default do processo. Vazio no
            // job = instalação sem seleção → lista do operador (comportamento
            // anterior). Fonte fora dos `providers` não é consultada.
            if !job.wants("jackett") {
                return Ok(CollectBatch {
                    items: Vec::new(),
                    partial: false,
                    live: Some(crate::orchestrator::live_state::LiveBatchState::default()),
                });
            }
            let selected = if job.jackett_indexers.is_empty() {
                &self.selected_indexers
            } else {
                &job.jackett_indexers
            };
            let media = JackettMediaType::parse(&job.kind);
            let planned = plan_jackett_searches(
                &job,
                selected,
                &self.pt_br_indexers,
                &self.isolate_indexers,
                &self.index_only_indexers,
                &self.live_exempt_indexers,
                self.shadow,
            );
            if planned.is_empty() {
                // Nenhuma consulta (ex.: só index-only): `Unknown` sem
                // indexers — não inventa sucesso nem falha.
                return Ok(CollectBatch {
                    items: Vec::new(),
                    partial: false,
                    live: Some(crate::orchestrator::live_state::LiveBatchState::default()),
                });
            }

            let mut handles = Vec::with_capacity(planned.len());
            for step in planned {
                let client = self.client.clone();
                let primary = step.primary;
                let handle = tokio::spawn(async move {
                    client
                        .search_outcomes(&step.query, media, &step.indexers, &step.options)
                        .await
                });
                handles.push((primary, handle));
            }

            let mut outcomes: Vec<QueryOutcome> = Vec::new();
            for (primary, handle) in handles {
                match handle.await {
                    Ok(mut step_outcomes) => {
                        // Sweep é secundário: a sombra compara só primárias.
                        for outcome in &mut step_outcomes {
                            outcome.primary = primary;
                        }
                        outcomes.extend(step_outcomes);
                    }
                    Err(err) => {
                        // JoinError: engole (fail-open), nunca propaga. Como não
                        // há outcome do passo, o estado vivo fica `Unknown` —
                        // ausência não vira sucesso.
                        eprintln!("[search] jackett collect: tarefa abortada: {err}");
                    }
                }
            }
            let (live, partial) = if self.shadow {
                // `record_status:false` é só para não registrar status; a
                // comparação da sombra precisa destes outcomes.
                live_state_from_outcomes_shadow(&outcomes, &job, self.title_precision_tail_cut)
            } else {
                live_state_from_outcomes(&outcomes, &job, self.title_precision_tail_cut)
            };
            let items = outcomes
                .into_iter()
                .flat_map(|outcome| outcome.items)
                .map(raw_from_jackett)
                .collect();
            Ok(CollectBatch {
                items,
                partial,
                live: Some(live),
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
#[path = "jackett_collector_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "jackett_shadow_tests.rs"]
mod shadow_tests;
