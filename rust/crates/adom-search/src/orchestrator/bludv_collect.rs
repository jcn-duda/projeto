//! `impl Collector` do BLUDV: lote + estado vivo da fonte.
//!
//! Separado de `bludv_collector.rs` apenas pelo teto de linhas (split mecanico).

use std::future::Future;
use std::pin::Pin;

use adom_sources::{BludvOutcome, BludvSearchOpts};

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::live_state::LiveBatchState;
use crate::raw_item::RawItem;

use super::bludv_collector::{
    br_query, live_empty, live_failed, live_from_items, live_ok, raw_from_bludv, BludvCollector,
};
fn batch(items: Vec<RawItem>, live: LiveBatchState) -> CollectBatch {
    CollectBatch {
        items,
        partial: false,
        live: Some(live),
    }
}

impl Collector for BludvCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            // Fonte BR independente do PROVIDER (só o kill-switch do cliente);
            // o `wants` existe para espelhar a régua do Node por fonte.
            if !job.wants("bludv") {
                return Ok(batch(Vec::new(), live_ok()));
            }
            // Topologia TS: bludv é tarefa BR (`priority=true`); globais e
            // late-sweep não consultam.
            if job.late_sweep || matches!(job.scope, TaskScope::Nonpriority) {
                return Ok(batch(Vec::new(), live_ok()));
            }
            let query = br_query(&job);
            if query.is_empty() {
                return Ok(batch(Vec::new(), live_ok()));
            }
            let opts = BludvSearchOpts {
                // `dubbedOnly` chega pelo `RequestSelection` (o default do
                // operador já foi aplicado ao `options` da request).
                dubbed_only: job.dubbed_only,
            };
            let outcome = self.client().search_outcome(query, &opts).await;
            let label = outcome.label();
            match outcome {
                BludvOutcome::Ok(items) => {
                    let live = live_from_items(&items, &job);
                    let mapped = items.into_iter().map(raw_from_bludv).collect();
                    Ok(batch(mapped, live))
                }
                // Configuração (kill-switch / base barrada / consulta vazia):
                // a fonte nem foi consultada — o Node também não registra nada.
                BludvOutcome::Disabled | BludvOutcome::BlockedUrl => {
                    Ok(batch(Vec::new(), live_ok()))
                }
                // 4xx da obra/site: o host está vivo; sem release para esta
                // obra → vazio suspeito (nunca falha sintética).
                BludvOutcome::Http(status) if status < 500 && status != 429 => {
                    eprintln!("[search] bludv: {label} (obra sem release no site)");
                    Ok(batch(Vec::new(), live_empty()))
                }
                // 429/5xx, rede, timeout e redirect inválido: a consulta foi
                // prometida e não foi respondida.
                failure => {
                    debug_assert!(failure.is_host_failure());
                    eprintln!("[search] bludv: {label} (falha viva, lote vazio)");
                    Ok(batch(Vec::new(), live_failed()))
                }
            }
        })
    }
}
