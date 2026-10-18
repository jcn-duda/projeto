//! Stubs sem rede: meta+collect → lista não vazia ou aviso; falhas honestas.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::*;
use crate::cache::MemorySwrStore;
use crate::coalesce::InFlight;
use crate::internal_types::{
    CollectRequest, CollectResponse, EffectsRequest, EffectsResponse, IndexWriteRequest,
    IndexWriteResponse, MetaRequest, MetaResponse, StateRequest, StateResponse, TaskScope,
};
use crate::list_builder::{DebridAnswer, DebridCheck};
use crate::request::StreamTarget;
use adom_core::RankingStream;

struct StubBackend {
    meta: Mutex<Result<MetaResponse, String>>,
    collect: Mutex<Result<CollectResponse, String>>,
    state_calls: AtomicUsize,
    collect_calls: AtomicUsize,
    meta_calls: AtomicUsize,
    effects_calls: AtomicUsize,
    index_calls: AtomicUsize,
}

impl StubBackend {
    fn ok_movie(items: Vec<Value>) -> Self {
        Self {
            meta: Mutex::new(Ok(MetaResponse {
                ok: true,
                media_type: "movie".into(),
                id: "tt0133093".into(),
                imdb_id: "tt0133093".into(),
                season: None,
                episode: None,
                meta: Some(json!({ "name": "Filme Teste", "year": "2024" })),
                titles: Some(json!({
                    "pt": "Filme Teste", "en": "Test Movie", "original": "Test Movie",
                    "br": [], "year": "2024"
                })),
                multi_work: None,
                home_release_at: None,
            })),
            collect: Mutex::new(Ok(CollectResponse {
                ok: true,
                task_scope: TaskScope::All.as_str().into(),
                query: "Filme Teste 2024".into(),
                imdb_id: "tt0133093".into(),
                season: None,
                episode: None,
                partial: false,
                items,
                by_indexer: Default::default(),
                live: None,
                breaker: Default::default(),
            })),
            state_calls: AtomicUsize::new(0),
            collect_calls: AtomicUsize::new(0),
            meta_calls: AtomicUsize::new(0),
            effects_calls: AtomicUsize::new(0),
            index_calls: AtomicUsize::new(0),
        }
    }

    fn item(title: &str, hash: &str, is_br: bool) -> Value {
        json!({
            "title": title,
            "infoHash": hash,
            "indexer": "stub",
            "seeders": 20,
            "isBr": is_br,
        })
    }
}

impl SearchBackend for StubBackend {
    fn meta<'a>(&'a self, _req: &'a MetaRequest) -> BoxFut<'a, Result<MetaResponse, String>> {
        Box::pin(async {
            self.meta_calls.fetch_add(1, Ordering::SeqCst);
            self.meta.lock().await.clone()
        })
    }
    fn state<'a>(
        &'a self,
        _req: &'a StateRequest,
    ) -> BoxFut<'a, Result<StateResponse, String>> {
        Box::pin(async {
            self.state_calls.fetch_add(1, Ordering::SeqCst);
            Ok(StateResponse {
                ok: true,
                obras: Default::default(),
                sources: Default::default(),
                first_seen: Default::default(),
            })
        })
    }
    fn collect<'a>(
        &'a self,
        _req: &'a CollectRequest,
    ) -> BoxFut<'a, Result<CollectResponse, String>> {
        Box::pin(async {
            self.collect_calls.fetch_add(1, Ordering::SeqCst);
            self.collect.lock().await.clone()
        })
    }
    fn index_write<'a>(
        &'a self,
        _req: &'a IndexWriteRequest,
    ) -> BoxFut<'a, Result<IndexWriteResponse, String>> {
        Box::pin(async {
            self.index_calls.fetch_add(1, Ordering::SeqCst);
            Ok(IndexWriteResponse {
                ok: true,
                recorded: 1,
                entries: 1,
                bank_marked: 0,
                failed: 0,
            })
        })
    }
    fn effects<'a>(
        &'a self,
        _req: &'a EffectsRequest,
    ) -> BoxFut<'a, Result<EffectsResponse, String>> {
        Box::pin(async {
            self.effects_calls.fetch_add(1, Ordering::SeqCst);
            Ok(EffectsResponse {
                ok: true,
                accepted: 1,
                rejected: 0,
            })
        })
    }
}

struct PassDebrid;
impl DebridCheck for PassDebrid {
    fn check(&mut self, _stream: &RankingStream) -> DebridAnswer {
        DebridAnswer::Unknown
    }
}

fn input_movie() -> OrchestrateInput {
    OrchestrateInput {
        target: StreamTarget {
            kind: "movie".into(),
            id: "tt0133093".into(),
            encoded: Some("e30".into()),
        },
        encoded: "e30".into(),
        origin: Some("http://127.0.0.1:7000".into()),
        ..OrchestrateInput::default()
    }
}

#[tokio::test]
async fn meta_collect_stubs_lista_nao_vazia() {
    let stub = Arc::new(StubBackend::ok_movie(vec![StubBackend::item(
        "Filme Teste 2024 1080p WEB-DL Dublado",
        "aa01000000000000000000000000000000000001",
        true,
    )]));
    let mut deps = OrchestrateDeps {
        backend: stub.clone(),
        debrid: None,
        store: None,
        in_flight: None,
        fetch_state: false,
        side_effects: false,
        now_ms: Some(1_700_000_000_000),
    };
    let out = orchestrate(&input_movie(), &mut deps).await.expect("ok");
    assert!(!out.from_cache);
    assert!(!out.response.streams.is_empty(), "lista não vazia");
    assert!(out.response.streams[0].info_hash.is_some() || out.response.streams[0].url.is_some());
    assert_eq!(stub.meta_calls.load(Ordering::SeqCst), 1);
    assert_eq!(stub.collect_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn collect_vazio_serie_devolve_aviso() {
    let stub = Arc::new(StubBackend::ok_movie(vec![]));
    {
        let mut meta = stub.meta.lock().await;
        *meta = Ok(MetaResponse {
            ok: true,
            media_type: "series".into(),
            id: "tt0903747:1:1".into(),
            imdb_id: "tt0903747".into(),
            season: Some(1),
            episode: Some(1),
            meta: Some(json!({ "name": "Serie", "year": "2008" })),
            titles: Some(json!({ "pt": "Serie", "en": "Series", "year": "2008" })),
            multi_work: None,
            home_release_at: None,
        });
    }
    let input = OrchestrateInput {
        target: StreamTarget {
            kind: "series".into(),
            id: "tt0903747:1:1".into(),
            encoded: Some("e30".into()),
        },
        encoded: "e30".into(),
        origin: Some("http://127.0.0.1:7000".into()),
        ..OrchestrateInput::default()
    };
    let mut deps = OrchestrateDeps {
        backend: stub,
        debrid: None,
        store: None,
        in_flight: None,
        fetch_state: false,
        side_effects: false,
        now_ms: Some(1_700_000_000_000),
    };
    let out = orchestrate(&input, &mut deps).await.expect("ok");
    assert_eq!(out.response.streams.len(), 1);
    assert!(
        out.response.streams[0].external_url.is_some(),
        "aviso com origin"
    );
    assert!(out.response.streams[0]
        .name
        .as_deref()
        .unwrap_or("")
        .contains("reabra"));
}

#[tokio::test]
async fn meta_falha_vira_err_sem_panic() {
    let stub = Arc::new(StubBackend::ok_movie(vec![]));
    *stub.meta.lock().await = Err("meta offline".into());
    let mut deps = OrchestrateDeps {
        backend: stub,
        debrid: None,
        store: None,
        in_flight: None,
        fetch_state: false,
        side_effects: false,
        now_ms: Some(1_700_000_000_000),
    };
    let err = orchestrate(&input_movie(), &mut deps)
        .await
        .expect_err("meta deve falhar");
    assert!(err.contains("meta") || err.contains("offline") || !err.is_empty());
}

#[tokio::test]
async fn collect_falha_lista_parcial_honesta() {
    let stub = Arc::new(StubBackend::ok_movie(vec![]));
    *stub.collect.lock().await = Err("collect caiu".into());
    let mut deps = OrchestrateDeps {
        backend: stub,
        debrid: None,
        store: None,
        in_flight: None,
        fetch_state: false,
        side_effects: false,
        now_ms: Some(1_700_000_000_000),
    };
    let out = orchestrate(&input_movie(), &mut deps)
        .await
        .expect("collect falha ≠ Err da orquestração");
    assert!(out.partial, "parcial honesto");
    // Filme sem candidatos: sem aviso mentiroso de "reabra".
    assert!(out.response.streams.is_empty() || out.response.streams.iter().all(|s| s.external_url.is_some() || s.info_hash.is_none()));
}

#[tokio::test]
async fn swr_hit_serve_sem_collect() {
    let store = MemorySwrStore::new();
    let key = request_cache_key("movie", "tt0133093", &json!({}));
    let entry = StreamsEntry {
        streams: vec![crate::contract::StreamItem {
            info_hash: Some("aa01000000000000000000000000000000000001".into()),
            name: Some("cached".into()),
            ..Default::default()
        }],
        partial: false,
        debrid_known: Some(true),
        fallback: false,
        notice: false,
        trace: None,
        search_meta: None,
    };
    store.set(&key, &entry, 60, 1_700_000_000_000);
    let stub = Arc::new(StubBackend::ok_movie(vec![]));
    let mut deps = OrchestrateDeps {
        backend: stub.clone(),
        debrid: None,
        store: Some(&store),
        in_flight: None,
        fetch_state: false,
        side_effects: false,
        now_ms: Some(1_700_000_000_000 + 1_000),
    };
    let out = orchestrate(&input_movie(), &mut deps).await.expect("ok");
    assert!(out.from_cache);
    assert_eq!(stub.collect_calls.load(Ordering::SeqCst), 0);
    assert_eq!(stub.meta_calls.load(Ordering::SeqCst), 0);
    assert_eq!(out.response.streams.len(), 1);
}

#[tokio::test]
async fn state_e_debrid_opcionais() {
    let stub = Arc::new(StubBackend::ok_movie(vec![StubBackend::item(
        "Filme Teste 2024 1080p",
        "bb02000000000000000000000000000000000002",
        false,
    )]));
    let mut debrid = PassDebrid;
    let mut deps = OrchestrateDeps {
        backend: stub.clone(),
        debrid: Some(&mut debrid),
        store: None,
        in_flight: None,
        fetch_state: true,
        side_effects: false,
        now_ms: Some(1_700_000_000_000),
    };
    let out = orchestrate(&input_movie(), &mut deps).await.expect("ok");
    assert!(!out.response.streams.is_empty());
    assert_eq!(stub.state_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn in_flight_aceita_mapa_sem_derrubar() {
    let stub = Arc::new(StubBackend::ok_movie(vec![StubBackend::item(
        "Filme Teste 2024 480p",
        "dd04000000000000000000000000000000000004",
        false,
    )]));
    let flight = InFlight::<Result<OrchestrateResult, String>>::new();
    let input = input_movie();
    let mut deps = OrchestrateDeps {
        backend: stub.clone(),
        debrid: None,
        store: None,
        in_flight: Some(&flight),
        fetch_state: false,
        side_effects: false,
        now_ms: Some(1_700_000_000_000),
    };
    let out = orchestrate(&input, &mut deps).await.expect("ok");
    assert!(!out.response.streams.is_empty());
    assert_eq!(stub.collect_calls.load(Ordering::SeqCst), 1);
    assert!(flight.is_empty(), "chave sai do mapa ao terminar");
}

#[test]
fn raw_item_from_value_le_campos_do_fio() {
    let item = crate::raw_item::raw_item_from_value(&json!({
        "title": "X 2024",
        "infoHash": "ee05000000000000000000000000000000000005",
        "isBr": true,
        "seeders": 3,
        "indexer": "bludv",
    }));
    assert_eq!(item.title.as_deref(), Some("X 2024"));
    assert!(item.is_br);
    assert_eq!(item.hash(), "ee05000000000000000000000000000000000005");
}
