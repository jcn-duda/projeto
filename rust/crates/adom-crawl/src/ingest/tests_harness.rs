//! Harness dos testes de ingestão: stores SQLite em memória, catálogo stub e
//! invalidadores que registram as chamadas.
//!
//! Nada aqui toca rede: o `ObraCatalog` de teste devolve o veredito que o caso
//! pediu e o `IngestStore` é o `NativeStore` de produção sobre `open_memory()`
//! (mesmo SQL do `magnets.db` e do `idx:v14`), com falhas injetáveis na captura
//! e na barreira de persistência.

use std::sync::{Arc, Mutex};

use adom_core::WorkTarget;
use adom_search::RawItem;
use adom_store::{
    IndexedRelease, MagnetBankStore, RecordOptions as IndexRecordOptions, ReleaseIndexStore,
    WorkCtx,
};
use serde_json::Value;

use super::catalog::{
    BoxFuture, IdentifyRequest, IdentifyVerdict, ObraCatalog, StreamInvalidator, WorkNames,
};
use super::store::{IngestStore, NativeStore};
use super::{CrawlObra, Ingest, IngestError, IngestOptions, PageReport};
use crate::motor::types::CrawlWorkResult;

/// `ingest::Ingest` montado com os colaboradores de teste.
pub(super) struct IngestHarness {
    store: MemStore,
    catalog: StubCatalog,
    invalidator: RecordingInvalidator,
}

impl IngestHarness {
    pub(super) fn new() -> Self {
        Self {
            store: MemStore::new(),
            catalog: StubCatalog::without_verdict(),
            invalidator: RecordingInvalidator::default(),
        }
    }

    /// Catálogo stub (o `with_tmdb` do plano; o stub real de TMDB é privado do
    /// `adom-sources`, então o harness usa a costura `ObraCatalog`).
    pub(super) fn with_catalog(mut self, catalog: StubCatalog) -> Self {
        self.catalog = catalog;
        self
    }

    /// Fila do banco vivo "cheia": a captura não entra.
    pub(super) fn failing_capture(mut self) -> Self {
        self.store.capture_ok = false;
        self
    }

    /// Barreira de persistência falhando depois da captura.
    pub(super) fn failing_flush(mut self) -> Self {
        self.store.flush_ok = false;
        self
    }

    pub(super) fn index(&self) -> Arc<ReleaseIndexStore> {
        self.store.native.index()
    }

    pub(super) fn invalidations(&self) -> Vec<String> {
        self.invalidator.calls()
    }

    pub(super) fn catalog_calls(&self) -> Vec<String> {
        self.catalog.calls()
    }

    /// `(partial, keep_partial)` de cada gravação no índice, na ordem.
    pub(super) fn record_opts(&self) -> Vec<(bool, bool)> {
        self.store
            .opts_log
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub(super) async fn apply(
        &self,
        site: &str,
        pages: &[CrawlWorkResult],
        now_ms: i64,
    ) -> Result<PageReport, IngestError> {
        let ingest = Ingest::new(
            self.store.clone(),
            self.catalog.clone(),
            self.invalidator.clone(),
        );
        ingest.apply(site, pages, now_ms).await
    }

    pub(super) async fn apply_guarded(
        &self,
        site: &str,
        page: &CrawlWorkResult,
        now_ms: i64,
        abort: &dyn Fn() -> bool,
    ) -> Result<PageReport, IngestError> {
        let ingest = Ingest::new(
            self.store.clone(),
            self.catalog.clone(),
            self.invalidator.clone(),
        );
        let options = IngestOptions {
            should_abort: Some(abort),
        };
        ingest
            .apply_many(site, std::slice::from_ref(page), now_ms, options)
            .await
    }

    pub(super) fn lookup(
        &self,
        imdb: &str,
        location: WorkTarget,
        now_ms: i64,
    ) -> Vec<IndexedRelease> {
        self.index().lookup(imdb, location, now_ms)
    }

    pub(super) fn is_partial(&self, imdb: &str, location: WorkTarget, now_ms: i64) -> bool {
        self.index().is_partial(imdb, location, now_ms)
    }

    /// Semeia o índice como uma busca COMPLETA anterior (`partial=false`).
    pub(super) fn seed_complete(
        &self,
        imdb: &str,
        location: WorkTarget,
        item: &RawItem,
        now_ms: i64,
    ) {
        let index = self.index();
        index
            .record(
                imdb,
                location,
                &[item.to_wire()],
                IndexRecordOptions {
                    partial: false,
                    keep_partial: false,
                    ..Default::default()
                },
                index.ttl(),
                index.max_releases(),
                now_ms,
                None,
            )
            .expect("semente do índice grava");
    }
}

/// `NativeStore` em memória com as duas falhas do caminho de erro.
#[derive(Clone)]
struct MemStore {
    native: NativeStore,
    capture_ok: bool,
    flush_ok: bool,
    /// Opções do índice de cada chamada (a prova de `partial`/`keepPartial`).
    opts_log: Arc<Mutex<Vec<(bool, bool)>>>,
}

impl MemStore {
    fn new() -> Self {
        let bank = MagnetBankStore::open_memory().expect("magnets.db em memória");
        let index = ReleaseIndexStore::open_memory().expect("idx em memória");
        Self {
            native: NativeStore::new(bank, index),
            capture_ok: true,
            flush_ok: true,
            opts_log: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl IngestStore for MemStore {
    fn capture_and_mark(
        &self,
        entered: &[RawItem],
        survivors: &[RawItem],
        source: &str,
        ctx: &WorkCtx,
        now_ms: i64,
    ) -> Result<bool, String> {
        if !self.capture_ok {
            return Ok(false);
        }
        self.native
            .capture_and_mark(entered, survivors, source, ctx, now_ms)
    }

    fn flush(&self) -> bool {
        self.flush_ok && self.native.flush()
    }

    fn lookup(&self, imdb: &str, location: WorkTarget, now_ms: i64) -> Vec<IndexedRelease> {
        self.native.lookup(imdb, location, now_ms)
    }

    fn is_partial(&self, imdb: &str, location: WorkTarget, now_ms: i64) -> bool {
        self.native.is_partial(imdb, location, now_ms)
    }

    fn record(
        &self,
        imdb: &str,
        location: WorkTarget,
        items: &[Value],
        opts: IndexRecordOptions<'_>,
        now_ms: i64,
    ) -> Result<usize, String> {
        self.opts_log
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push((opts.partial, opts.keep_partial));
        self.native.record(imdb, location, items, opts, now_ms)
    }
}

/// Catálogo de teste: devolve um veredito fixo e nomes fixos, registrando as
/// chamadas para os testes distinguirem "não consultou" de "consultou".
#[derive(Clone)]
pub(super) struct StubCatalog {
    verdict: IdentifyVerdict,
    names: Option<WorkNames>,
    calls: Arc<Mutex<Vec<String>>>,
}

impl StubCatalog {
    /// Página de filme que já identifica: obra `imdb`, nome "Filme Teste".
    pub(super) fn movie(imdb: &str) -> Self {
        Self::identified(imdb, "Filme Teste", 2024)
    }

    /// Página de série que identifica: `year` é o ano do catálogo.
    pub(super) fn series(year: i64, imdb: &str) -> Self {
        Self::identified(imdb, "Serie Teste", year)
    }

    pub(super) fn ambiguous(title: &str) -> Self {
        Self {
            verdict: IdentifyVerdict::ambiguous("homonimo-ambiguo"),
            names: Some(WorkNames {
                names: vec![title.to_string()],
                year: Some(2021),
            }),
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub(super) fn unavailable() -> Self {
        Self {
            verdict: IdentifyVerdict::unavailable("tmdb-indisponivel"),
            names: None,
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub(super) fn without_names() -> Self {
        Self {
            verdict: IdentifyVerdict::identified("tt777"),
            names: None,
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn without_verdict() -> Self {
        Self::identified("tt000", "Nenhuma Obra", 2000)
    }

    fn identified(imdb: &str, name: &str, year: i64) -> Self {
        Self {
            verdict: IdentifyVerdict::identified(imdb),
            names: Some(WorkNames {
                names: vec![name.to_string()],
                year: Some(year),
            }),
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub(super) fn calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }
}

impl ObraCatalog for StubCatalog {
    fn identify<'a>(&'a self, request: &'a IdentifyRequest) -> BoxFuture<'a, IdentifyVerdict> {
        let verdict = self.verdict.clone();
        let call = format!("identify:{}:{}", request.kind.as_str(), request.title);
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push(call);
            verdict
        })
    }

    fn names<'a>(&'a self, obra: &'a CrawlObra) -> BoxFuture<'a, Option<WorkNames>> {
        let names = self.names.clone();
        let call = format!("names:{}", obra.imdb);
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push(call);
            names
        })
    }
}

/// Invalidadores que registram cada obra invalidada (a prova das asserções).
#[derive(Clone, Default)]
pub(super) struct RecordingInvalidator {
    calls: Arc<Mutex<Vec<String>>>,
}

impl RecordingInvalidator {
    pub(super) fn calls(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }
}

impl StreamInvalidator for RecordingInvalidator {
    fn invalidate<'a>(&'a self, imdb_id: &'a str) -> BoxFuture<'a, bool> {
        let calls = self.calls.clone();
        let imdb = imdb_id.to_string();
        Box::pin(async move {
            calls
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .push(imdb);
            true
        })
    }
}
