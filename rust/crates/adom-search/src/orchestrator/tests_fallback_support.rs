use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::test_support::*;
use crate::orchestrator::live_state::{LiveAllState, LiveBatchState};

pub(super) const FALLBACK_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

pub(super) fn wall_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) fn live(failed: &[&str], pending: &[&str], empty: &[&str]) -> LiveBatchState {
    LiveBatchState {
        failed: failed.iter().map(|s| s.to_string()).collect(),
        pending: pending.iter().map(|s| s.to_string()).collect(),
        empty: empty.iter().map(|s| s.to_string()).collect(),
        all: LiveAllState::Ok,
    }
}

/// Coletor que devolve o MESMO lote vivo para qualquer task (o build deduplica
/// por hash). É o mínimo para o estado `failed` chegar ao `first_live`.
pub(super) struct LiveCollector {
    pub(super) items: Vec<RawItem>,
    pub(super) live: LiveBatchState,
}

impl Collector for LiveCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(CollectBatch {
                items: self.items.clone(),
                partial: false,
                live: Some(self.live.clone()),
            })
        })
    }
}

pub(super) fn fallback_response() -> FallbackResponse {
    let mut sources = std::collections::BTreeMap::new();
    sources.insert(
        FALLBACK_HASH.to_string(),
        vec![FallbackSourceWire {
            indexer: "bludv".into(),
            tracker: "BLUDV".into(),
            last_seen: 10,
            allowed: true,
        }],
    );
    FallbackResponse {
        ok: true,
        enabled: true,
        fallback_enabled: true,
        per_indexer_max: 40,
        global_max: 40,
        br_indexers: vec!["bludv".into()],
        index_only_indexers: vec![],
        works: vec![FallbackWorkWire {
            hash: FALLBACK_HASH.into(),
            passed_filter: 1,
            last_seen: 10,
            magnet: Some(FallbackMagnetWire {
                hash: FALLBACK_HASH.into(),
                uri: format!("magnet:?xt=urn:btih:{FALLBACK_HASH}"),
                title: "Filme Teste 2024 1080p Dublado (Banco)".into(),
                size: 1024,
                is_br: true,
                dubbed: true,
                quality: "1080p".into(),
                seeders_max: 9,
                seeders_last: 7,
                last_seen: 10,
                lied: false,
            }),
        }],
        sources,
    }
}

#[derive(Default)]
pub(super) struct FallbackRoutes {
    calls: Mutex<Vec<FallbackRequest>>,
    response: Mutex<Option<Result<FallbackResponse, String>>>,
}

impl FallbackRoutes {
    pub(super) fn new(response: FallbackResponse) -> Arc<Self> {
        Arc::new(FallbackRoutes {
            calls: Mutex::new(Vec::new()),
            response: Mutex::new(Some(Ok(response))),
        })
    }

    pub(super) fn failing(error: &str) -> Arc<Self> {
        Arc::new(FallbackRoutes {
            calls: Mutex::new(Vec::new()),
            response: Mutex::new(Some(Err(error.to_string()))),
        })
    }

    pub(super) fn not_ok() -> Arc<Self> {
        let mut response = fallback_response();
        response.ok = false;
        Self::new(response)
    }

    pub(super) fn calls(&self) -> Vec<FallbackRequest> {
        self.calls.lock().expect("calls").clone()
    }
}

impl InternalRoutes for FallbackRoutes {
    fn meta<'a>(&'a self, _req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async { Err("meta não usado".into()) })
    }

    fn collect<'a>(&'a self, _req: CollectRequest) -> RouteFuture<'a, CollectResponse> {
        Box::pin(async { Err("collect não usado".into()) })
    }

    fn index_write<'a>(&'a self, _req: IndexWriteRequest) -> RouteFuture<'a, IndexWriteResponse> {
        Box::pin(async {
            Ok(IndexWriteResponse {
                ok: true,
                recorded: 0,
                entries: 0,
                bank_marked: 0,
                failed: 0,
            })
        })
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

    fn search_index<'a>(
        &'a self,
        _req: SearchIndexRequest,
    ) -> RouteFuture<'a, SearchIndexResponse> {
        Box::pin(async { Ok(SearchIndexResponse::default()) })
    }

    fn fallback<'a>(&'a self, req: FallbackRequest) -> RouteFuture<'a, FallbackResponse> {
        self.calls.lock().expect("calls").push(req);
        let response = self
            .response
            .lock()
            .expect("response")
            .clone()
            .expect("resposta de fallback");
        Box::pin(async move { response })
    }
}

/// Rota que ignora o `deadline_at` do pedido e demora de propósito: o corte
/// tem que ser do orquestrador, não da boa vontade da rota.
pub(super) struct SlowFallbackRoutes {
    delay: Duration,
    calls: AtomicUsize,
}

impl SlowFallbackRoutes {
    pub(super) fn new(delay: Duration) -> Arc<Self> {
        Arc::new(SlowFallbackRoutes {
            delay,
            calls: AtomicUsize::new(0),
        })
    }

    pub(super) fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl InternalRoutes for SlowFallbackRoutes {
    fn meta<'a>(&'a self, _req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async { Err("meta não usado".into()) })
    }

    fn collect<'a>(&'a self, _req: CollectRequest) -> RouteFuture<'a, CollectResponse> {
        Box::pin(async { Err("collect não usado".into()) })
    }

    fn index_write<'a>(&'a self, _req: IndexWriteRequest) -> RouteFuture<'a, IndexWriteResponse> {
        Box::pin(async {
            Ok(IndexWriteResponse {
                ok: true,
                recorded: 0,
                entries: 0,
                bank_marked: 0,
                failed: 0,
            })
        })
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

    fn search_index<'a>(
        &'a self,
        _req: SearchIndexRequest,
    ) -> RouteFuture<'a, SearchIndexResponse> {
        Box::pin(async { Ok(SearchIndexResponse::default()) })
    }

    fn fallback<'a>(&'a self, _req: FallbackRequest) -> RouteFuture<'a, FallbackResponse> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let delay = self.delay;
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            Ok(fallback_response())
        })
    }
}
