//! Helpers compartilhados pelos testes da sombra (módulo incluído por cada
//! arquivo de teste; sem dependência do módulo pai além dos tipos públicos).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::{ReferenceCollector, ReferenceFuture};
use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::live_state::{LiveAllState, LiveBatchState};
use crate::raw_item::RawItem;

pub struct StubCollector {
    pub result: Result<CollectBatch, String>,
    pub delay_ms: u64,
}

impl Collector for StubCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        let result = self.result.clone();
        let delay = self.delay_ms;
        Box::pin(async move {
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            result
        })
    }
}

pub struct StubReference {
    pub result: Result<(CollectBatch, bool), String>,
    pub delay_ms: u64,
}

impl ReferenceCollector for StubReference {
    fn reference<'a>(&'a self, _job: CollectJob) -> ReferenceFuture<'a> {
        let result = self.result.clone();
        let delay = self.delay_ms;
        Box::pin(async move {
            if delay > 0 {
                tokio::time::sleep(Duration::from_millis(delay)).await;
            }
            result
        })
    }
}

pub fn item(indexer: &str, hash: &str) -> RawItem {
    RawItem {
        indexer: Some(indexer.to_string()),
        info_hash: Some(hash.to_string()),
        ..RawItem::default()
    }
}

pub fn batch(items: Vec<RawItem>, partial: bool, live: Option<LiveBatchState>) -> CollectBatch {
    CollectBatch {
        items,
        partial,
        live,
    }
}

pub fn live(
    failed: &[&str],
    pending: &[&str],
    empty: &[&str],
    all: LiveAllState,
) -> LiveBatchState {
    let set = |items: &[&str]| items.iter().map(|s| s.to_string()).collect();
    LiveBatchState {
        failed: set(failed),
        pending: set(pending),
        empty: set(empty),
        all,
    }
}

pub fn job(deadline_at: i64) -> CollectJob {
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
        pt_query: None,
        sweep_query: None,
        original_query: None,
        multi_work_query: None,
        priority: false,
        deadline_at,
        late_sweep: false,
        providers: Vec::new(),
        jackett_indexers: Vec::new(),
        dubbed_only: false,
        mico_default: false,
    }
}

pub fn late_job() -> CollectJob {
    CollectJob {
        late_sweep: true,
        providers: Vec::new(),
        jackett_indexers: Vec::new(),
        dubbed_only: false,
        mico_default: false,
        ..job(1_700_000_000_000)
    }
}

pub fn stub(result: Result<CollectBatch, String>, delay_ms: u64) -> Arc<dyn Collector> {
    Arc::new(StubCollector { result, delay_ms })
}

pub fn stub_ref(
    result: Result<(CollectBatch, bool), String>,
    delay_ms: u64,
) -> Arc<dyn ReferenceCollector> {
    Arc::new(StubReference { result, delay_ms })
}
