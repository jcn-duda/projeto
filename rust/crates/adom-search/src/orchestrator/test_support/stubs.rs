//! Dublês compartilhados dos testes do orquestrador (coletor, meta, debrid,
//! cauda, índice e banco). Reexportados por `test_support` com os MESMOS
//! nomes e o mesmo caminho de antes.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::{BankRow, InstantSource, InstantWork, RankingStream, WorkTarget};
use serde_json::Value;

use super::{item, meta, DebridAnswer, DebridCheck, ReleaseEntry, HASH};
use crate::orchestrator::*;
use crate::raw_item::RawItem;

// ── Stubs ───────────────────────────────────────────────────────────────────

pub struct StubCollector {
    batches: Mutex<Vec<CollectBatch>>,
    always: Option<CollectBatch>,
    calls: AtomicUsize,
    delay: Duration,
    fail: bool,
}

impl StubCollector {
    pub fn with(items: Vec<RawItem>) -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(vec![CollectBatch {
                items,
                partial: false,
                live: None,
            }]),
            always: None,
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: false,
        })
    }

    pub fn with_always(items: Vec<RawItem>) -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(Vec::new()),
            always: Some(CollectBatch {
                items,
                partial: false,
                live: None,
            }),
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: false,
        })
    }

    pub fn empty() -> Arc<Self> {
        Self::with(Vec::new())
    }

    /// Balde vazio mas coleta ainda aberta (`partial:true`) — o Node devolve
    /// isto quando a janela corta e o completion segue em fundo.
    pub fn empty_partial() -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(vec![CollectBatch {
                items: Vec::new(),
                partial: true,
                live: None,
            }]),
            always: None,
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: false,
        })
    }

    pub fn failing() -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(Vec::new()),
            always: None,
            calls: AtomicUsize::new(0),
            delay: Duration::ZERO,
            fail: true,
        })
    }

    pub fn slow(items: Vec<RawItem>, delay: Duration) -> Arc<Self> {
        Arc::new(StubCollector {
            batches: Mutex::new(vec![CollectBatch {
                items,
                partial: false,
                live: None,
            }]),
            always: None,
            calls: AtomicUsize::new(0),
            delay,
            fail: false,
        })
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
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
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            if self.fail {
                return Err("coletor fora do ar".into());
            }
            if let Some(always) = &self.always {
                return Ok(always.clone());
            }
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

/// Meta + collect que gravam o `encoded` recebido (prova do path sem config).
#[derive(Default)]
pub struct RecordingBackend {
    pub meta_encoded: Mutex<Vec<String>>,
    pub collect_encoded: Mutex<Vec<String>>,
}

impl MetaSource for RecordingBackend {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move {
            self.meta_encoded
                .lock()
                .expect("meta_encoded")
                .push(req.encoded.clone());
            Ok(meta())
        })
    }
}

impl Collector for RecordingBackend {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            self.collect_encoded
                .lock()
                .expect("collect_encoded")
                .push(job.encoded.clone());
            Ok(CollectBatch {
                items: vec![item(HASH)],
                partial: false,
                live: None,
            })
        })
    }
}

pub struct StubCheck {
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

#[derive(Default)]
pub struct RecordingTail {
    effects: Mutex<Vec<EffectsBatch>>,
}

impl RecordingTail {
    pub fn effects_batches(&self) -> Vec<EffectsBatch> {
        self.effects.lock().expect("effects").clone()
    }
}

impl TailEffects for RecordingTail {
    fn effects<'a>(
        &'a self,
        batch: EffectsBatch,
    ) -> RouteFuture<'a, crate::internal_types::EffectsResponse> {
        Box::pin(async move {
            let accepted = batch.effects.len() as i64;
            self.effects.lock().expect("effects").push(batch);
            Ok(crate::internal_types::EffectsResponse {
                ok: true,
                accepted,
                rejected: 0,
            })
        })
    }
}

/// Índice nativo de teste: `lookup` devolve as releases configuradas e
/// `record` guarda os lotes para asserção.
#[derive(Default)]
pub struct StubIndex {
    pub releases: Vec<IndexedReleaseWire>,
    pub partial: bool,
    records: Mutex<Vec<ReleaseEntry>>,
}

impl StubIndex {
    pub fn with(releases: Vec<IndexedReleaseWire>) -> Arc<Self> {
        Arc::new(StubIndex {
            releases,
            ..StubIndex::default()
        })
    }

    pub fn recorded(&self) -> Vec<ReleaseEntry> {
        self.records.lock().expect("records").clone()
    }
}

impl ReleaseIndexSource for StubIndex {
    fn lookup(
        &self,
        _imdb: &str,
        _season: Option<i64>,
        _episode: Option<i64>,
        _now: i64,
    ) -> Vec<IndexedReleaseWire> {
        self.releases.clone()
    }

    fn is_partial(
        &self,
        _imdb: &str,
        _season: Option<i64>,
        _episode: Option<i64>,
        _now: i64,
    ) -> bool {
        self.partial
    }

    fn record(
        &self,
        entry: &ReleaseEntry,
        _now: i64,
        _bank: Option<BankLookup<'_>>,
    ) -> Result<usize, String> {
        self.records.lock().expect("records").push(entry.clone());
        Ok(entry.items.len())
    }
}

/// Banco nativo de teste: linhas de obra + fontes fixas, com contador de
/// leituras para provar quando a reserva foi (ou não) consultada.
#[derive(Default)]
pub struct StubBank {
    pub works: Vec<InstantWork>,
    pub sources: std::collections::BTreeMap<String, Vec<InstantSource>>,
    pub br_row: bool,
    reads: AtomicUsize,
}

impl StubBank {
    pub fn new(
        works: Vec<InstantWork>,
        sources: std::collections::BTreeMap<String, Vec<InstantSource>>,
    ) -> Arc<Self> {
        Arc::new(StubBank {
            works,
            sources,
            ..StubBank::default()
        })
    }

    pub fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }
}

impl MagnetBankSource for StubBank {
    fn works_for_obra_many(
        &self,
        _imdb: &str,
        _targets: &[WorkTarget],
        _limit_per_target: usize,
        _max_total: usize,
        _indexers: Option<&[String]>,
    ) -> Vec<InstantWork> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.works.clone()
    }

    fn sources_for_many(
        &self,
        hashes: &[String],
    ) -> std::collections::BTreeMap<String, Vec<InstantSource>> {
        hashes
            .iter()
            .filter_map(|hash| {
                self.sources
                    .get(hash)
                    .map(|list| (hash.clone(), list.clone()))
            })
            .collect()
    }

    fn bank_rows_many(&self, _hashes: &[String]) -> Vec<BankRow> {
        Vec::new()
    }

    fn mark_filter_outcome(
        &self,
        _entered: &[Value],
        _survivors: &[Value],
        _ctx: &BankFilterCtx,
        _now: i64,
    ) -> bool {
        true
    }

    fn has_br_row(&self, _imdb: &str, _targets: &[WorkTarget]) -> bool {
        self.br_row
    }
}
