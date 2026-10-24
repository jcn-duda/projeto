//! Rotas internas congeladas: a captura responde meta/collect/fallback.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::internal_types::{EffectsRequest, EffectsResponse, MetaRequest, MetaResponse};
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::internal_routes::{InternalRoutes, RouteFuture};
use crate::orchestrator::live_state::LiveBatchState;
use crate::raw_item::raw_item_from_value;

use super::capture::{BatchFile, CollectFile};

// ── rotas congeladas ────────────────────────────────────────────────────────

pub(super) struct FrozenRoutes {
    pub(super) meta: MetaResponse,
    pub(super) collect: Vec<CollectFile>,
    /// Itens da reserva 📦 injetados pelo Node neste caso.
    pub(super) fallback: Option<Vec<Value>>,
    pub(super) pt_br: Vec<String>,
}

impl FrozenRoutes {
    fn batch(&self, scope: &str, season: Option<i64>, episode: Option<i64>) -> BatchFile {
        if let Some(entry) = self.collect.iter().find(|entry| {
            entry.key.scope == scope && entry.key.season == season && entry.key.episode == episode
        }) {
            return BatchFile {
                items: entry.response.items.clone(),
                partial: entry.response.partial,
                live: entry.response.live.clone(),
            };
        }
        // O Node faz UMA coleta `all` (o collectRaw interno separa os grupos).
        // O plano Rust pede `priority`/`nonpriority`: particiona o mesmo lote
        // pela lista pt-BR, exatamente como o `plan_jackett_queries` faria.
        let Some(all) = self.collect.iter().find(|entry| entry.key.scope == "all") else {
            return BatchFile::default();
        };
        let is_br = |item: &Value| {
            let indexer = item.get("indexer").and_then(Value::as_str).unwrap_or("");
            self.pt_br.iter().any(|id| id == indexer)
        };
        let items = all
            .response
            .items
            .iter()
            .filter(|item| match scope {
                "priority" => is_br(item),
                "nonpriority" => !is_br(item),
                _ => true,
            })
            .cloned()
            .collect();
        BatchFile {
            items,
            partial: all.response.partial,
            live: all.response.live.clone(),
        }
    }
}

/// Coletor de REPLAY do corpus: entrega o lote gravado do caso com a mesma
/// forma que o antigo coletor Node produzia (itens, `partial` e `live`),
/// sem HTTP. O gate mede o orquestrador REAL; só a fronteira de coleta é
/// substituída pelo dado congelado.
pub(super) struct ReplayCollector {
    routes: Arc<FrozenRoutes>,
}

impl ReplayCollector {
    pub(super) fn new(routes: Arc<FrozenRoutes>) -> Self {
        ReplayCollector { routes }
    }
}

impl Collector for ReplayCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            let batch = self
                .routes
                .batch(job.scope.as_str(), job.season, job.episode);
            Ok(CollectBatch {
                items: batch.items.iter().map(raw_item_from_value).collect(),
                partial: batch.partial,
                // Contrato vivo completo (failed/pending/empty/aggregate);
                // `None` no caso segue sem provar nada.
                live: batch.live.as_ref().map(LiveBatchState::from_wire),
            })
        })
    }
}

impl InternalRoutes for FrozenRoutes {
    fn meta<'a>(&'a self, _req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async move { Ok(self.meta.clone()) })
    }

    fn effects<'a>(&'a self, _req: EffectsRequest) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async {
            Ok(EffectsResponse {
                ok: true,
                accepted: 0,
                rejected: 0,
            })
        })
    }

    fn fallback_injected<'a>(&'a self) -> RouteFuture<'a, Option<Vec<Value>>> {
        Box::pin(async move { Ok(self.fallback.clone()) })
    }
}
