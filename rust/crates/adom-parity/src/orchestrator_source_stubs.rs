use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use adom_core::RankingStream;
use adom_search::list_builder::{DebridAnswer, DebridCheck};
use adom_search::orchestrator::{
    CollectBatch, CollectJob, Collector, DebridContext, DebridFactory, MetaQuery, MetaSource,
    RouteFuture, SearchMeta,
};
use adom_search::raw_item::{raw_item_from_value, RawItem};
use serde_json::Value;

use crate::runner::SourceError;

pub fn search_meta_from_fixture(v: &Value) -> Result<SearchMeta, SourceError> {
    let imdb_id = str_of(v, &["imdb_id", "imdbId"]).unwrap_or_default();
    let name = str_of(v, &["name"]).unwrap_or_else(|| imdb_id.clone());
    let names = v
        .get("names")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| {
            if name.is_empty() {
                Vec::new()
            } else {
                vec![name.clone()]
            }
        });
    let year = v.get("year").cloned().unwrap_or(Value::Null);
    let query = str_of(v, &["query"]).unwrap_or_else(|| {
        let year_text = match &year {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        };
        if year_text.is_empty() {
            name.clone()
        } else {
            format!("{name} {year_text}")
        }
    });
    Ok(SearchMeta {
        imdb_id,
        season: i64_of(v, &["season"]),
        episode: i64_of(v, &["episode"]),
        name,
        names,
        year,
        alt_year: str_of(v, &["alt_year", "altYear"]),
        query,
        pt_query: str_of(v, &["pt_query", "ptQuery"]),
        pt_title: str_of(v, &["pt_title", "ptTitle"]),
        titles: None,
        sweep_query: str_of(v, &["sweep_query", "sweepQuery"]),
        original_query: str_of(v, &["original_query", "originalQuery"]),
        multi_work_root: str_of(v, &["multi_work_root", "multiWorkRoot"]),
        multi_work_query: str_of(v, &["multi_work_query", "multiWorkQuery"]),
        episode_counts: Vec::new(),
        is_demo: v
            .get("is_demo")
            .or_else(|| v.get("isDemo"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub fn raw_items_from_fixture(v: &Value) -> Result<Vec<RawItem>, SourceError> {
    let arr = v
        .as_array()
        .ok_or_else(|| SourceError::new("raw.json deve ser um array de itens"))?;
    Ok(arr.iter().map(raw_item_from_value).collect())
}

pub fn cached_hashes_from_fixture(v: &Value) -> Vec<String> {
    v.get("cached")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn str_of(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| {
        v.get(*k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

fn i64_of(v: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|k| {
        v.get(*k).and_then(|x| match x {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.parse().ok(),
            _ => None,
        })
    })
}

// ── Stubs (espelho mínimo dos testes do adom-search) ────────────────────────

pub struct StubCollector {
    batches: Mutex<Vec<CollectBatch>>,
    calls: AtomicUsize,
}

impl StubCollector {
    pub fn with(items: Vec<RawItem>) -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(vec![CollectBatch {
                items,
                partial: false,
                live: None,
            }]),
            calls: AtomicUsize::new(0),
        })
    }
}

impl Collector for StubCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut guard = self.batches.lock().expect("batches");
            if guard.is_empty() {
                Ok(CollectBatch::default())
            } else {
                Ok(guard.remove(0))
            }
        })
    }
}

pub struct StubMeta(pub SearchMeta);

impl MetaSource for StubMeta {
    fn resolve<'a>(&'a self, _req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
}

struct StubCheck {
    cached: Vec<String>,
}

impl DebridCheck for StubCheck {
    fn check(&mut self, stream: &RankingStream) -> DebridAnswer {
        let hash = stream.info_hash.clone().unwrap_or_default();
        if self.cached.contains(&hash) {
            DebridAnswer::Cached { url: None }
        } else {
            DebridAnswer::Missing
        }
    }
}

pub struct StubDebrid {
    pub cached: Vec<String>,
}

impl DebridFactory for StubDebrid {
    fn make(&self, _ctx: &DebridContext) -> Box<dyn DebridCheck + Send> {
        Box::new(StubCheck {
            cached: self.cached.clone(),
        })
    }
}
