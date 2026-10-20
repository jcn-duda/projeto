//! Testes da parte informativa/elegibilidade da sombra (extraídos de
//! `source_shadow_tests.rs` pela catraca de 400 linhas).

use std::sync::{Arc, Mutex};

use adom_sources::now_ms;

use super::*;
use crate::internal_types::{
    CollectRequest, CollectResponse, EffectsRequest, EffectsResponse, FallbackRequest,
    FallbackResponse, IndexWriteRequest, IndexWriteResponse, MetaRequest, MetaResponse,
    SearchIndexRequest, SearchIndexResponse,
};
use crate::orchestrator::collect::Collector;
use crate::orchestrator::internal_routes::RouteFuture;
use crate::orchestrator::live_state::LiveAllState;
use serde_json::json;

use super::test_support::{batch, item, job, late_job, live, stub, stub_ref};

fn pair(native: Arc<dyn Collector>, node: Arc<dyn ReferenceCollector>) -> ShadowPair {
    ShadowPair {
        source: "jackett",
        native,
        node,
        compare_live: true,
    }
}

#[test]
fn partial_diferente_nao_e_divergencia_de_fonte() {
    let state = live(&[], &[], &[], LiveAllState::Ok);
    // Mesmos itens: a ÚNICA diferença é a janela do Node (partial=true).
    let itens = vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")];
    let native = batch(itens.clone(), false, Some(state.clone()));
    let node = batch(itens, true, Some(state));
    let comparison = compare_batches(&native, &node);
    assert!(comparison.partial_divergence);
    assert!(!comparison.diverged(), "partial é janela, não fonte");

    let metrics = SourceShadowMetrics::new();
    record_comparison("jackett", &native, &node, &metrics);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(
        metrics.get(DIVERGENCE),
        0,
        "partial não entra em divergence"
    );
    assert_eq!(metrics.get(PARTIAL_DIVERGENCE), 1, "métrica informativa");
}

#[tokio::test]
async fn late_sweep_nao_roda_sombra() {
    let metrics = SourceShadowMetrics::new();
    let native = stub(Ok(batch(vec![], false, None)), 0);
    let node = stub_ref(Ok((batch(vec![], false, None), true)), 0);
    run_pair(pair(native, node), late_job(), metrics.clone()).await;
    assert_eq!(metrics.get(SKIPPED_LATE), 1);
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(ERROR), 0);
}

#[test]
fn card_exempt_nao_vira_missing_nem_extra() {
    // Mesmo card isento dos dois lados (o nativo agora usa a mesma lista).
    let card = item(
        "apachetorrent-cardigann",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    let native = batch(vec![card.clone()], false, None);
    let node = batch(vec![card], false, None);
    let comparison = compare_batches(&native, &node);
    assert_eq!(comparison.missing_count, 0);
    assert_eq!(comparison.extra_count, 0);
    assert!(!comparison.diverged());
}

#[test]
fn snapshot_expoe_partial_divergence_e_skipped() {
    let metrics = SourceShadowMetrics::new();
    let snapshot = metrics.snapshot();
    assert!(snapshot.contains_key(PARTIAL_DIVERGENCE));
    assert!(snapshot.contains_key(SKIPPED));
    assert!(snapshot.contains_key(SKIPPED_LATE));
    assert_eq!(snapshot.get(DIVERGENCE), Some(&0));
}

#[tokio::test]
async fn fonte_fora_dos_providers_pula_sem_comparar() {
    let metrics = SourceShadowMetrics::new();
    let state = live(&[], &[], &[], LiveAllState::Ok);
    let ok = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(state),
    );
    let native = stub(Ok(ok.clone()), 0);
    // Node responde vazio com eligible=false: não há referência válida.
    let node = stub_ref(Ok((batch(vec![], false, None), false)), 0);
    run_pair(pair(native, node), job(now_ms() + 1_000), metrics.clone()).await;
    assert_eq!(metrics.get(SKIPPED), 1);
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(ERROR), 0);
}

/// O `NodeCollector` real da sombra: skip_sources de todas as outras fontes,
/// `read_only` e `shadow_source` no corpo (nenhum efeito no Node).
#[derive(Default)]
struct RecordingRoutes {
    seen: Mutex<Vec<CollectRequest>>,
}

impl InternalRoutes for RecordingRoutes {
    fn meta<'a>(&'a self, _req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async { Err("não usado".to_string()) })
    }

    fn collect<'a>(&'a self, req: CollectRequest) -> RouteFuture<'a, CollectResponse> {
        self.seen.lock().expect("requests").push(req);
        Box::pin(async {
            let wire = json!({
                "ok": true,
                "task_scope": "all",
                "query": "The Matrix 1999",
                "imdb_id": "tt0133093",
                "partial": false,
                "items": [],
                "breaker": {}
            });
            serde_json::from_value(wire).map_err(|err| err.to_string())
        })
    }

    fn index_write<'a>(&'a self, _req: IndexWriteRequest) -> RouteFuture<'a, IndexWriteResponse> {
        Box::pin(async { Err("não usado".to_string()) })
    }

    fn effects<'a>(&'a self, _req: EffectsRequest) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async { Err("não usado".to_string()) })
    }

    fn search_index<'a>(
        &'a self,
        _req: SearchIndexRequest,
    ) -> RouteFuture<'a, SearchIndexResponse> {
        Box::pin(async { Err("não usado".to_string()) })
    }

    fn fallback<'a>(&'a self, _req: FallbackRequest) -> RouteFuture<'a, FallbackResponse> {
        Box::pin(async { Ok(FallbackResponse::default()) })
    }
}

#[tokio::test]
async fn wrapper_da_sombra_manda_skip_sources_e_read_only() {
    let routes = Arc::new(RecordingRoutes::default());
    let collector = node_collector_for_source(routes.clone(), "jackett", Some(vec!["yts".into()]));
    let batch = collector
        .collect(job(now_ms() + 2_000))
        .await
        .expect("coleta");
    assert!(batch.items.is_empty());
    let requests = routes.seen.lock().expect("requests");
    let request = requests.first().expect("uma requisição");
    assert!(request.read_only, "sombra não pode ter efeitos no Node");
    assert_eq!(
        request.shadow_source.as_deref(),
        Some("jackett"),
        "rota confere a fonte nos providers efetivos"
    );
    assert_eq!(
        request.indexers.as_deref(),
        Some(&["yts".to_string()][..]),
        "sombra leva JACKETT_INDEXERS do processo"
    );
    assert_eq!(
        request.skip_sources,
        vec![
            "prowlarr".to_string(),
            "torrentio".to_string(),
            "bludv".to_string(),
            "mico".to_string()
        ]
    );
}

/// Prowlarr: a referência pula as outras fontes, mas NÃO manda override de
/// `JACKETT_INDEXERS` (não são indexers do Prowlarr); o `ji` da request segue
/// no job quando existir.
#[tokio::test]
async fn wrapper_da_sombra_prowlarr_manda_skip_sources_sem_override() {
    let routes = Arc::new(RecordingRoutes::default());
    let collector = node_collector_for_source(routes.clone(), "prowlarr", None);
    collector
        .collect(job(now_ms() + 2_000))
        .await
        .expect("coleta");
    let requests = routes.seen.lock().expect("requests");
    let request = requests.first().expect("uma requisição");
    assert!(request.read_only, "sombra não pode ter efeitos no Node");
    assert_eq!(request.shadow_source.as_deref(), Some("prowlarr"));
    assert_eq!(
        request.skip_sources,
        vec![
            "jackett".to_string(),
            "torrentio".to_string(),
            "bludv".to_string(),
            "mico".to_string()
        ]
    );
    assert_eq!(
        request.indexers, None,
        "Prowlarr não tem lista de JACKETT_INDEXERS"
    );
}

/// C0b: quando o job traz o `ji` da request, a referência usa ESSA seleção —
/// o override do processo fica só como fallback de instalação sem `ji`.
#[tokio::test]
async fn sombra_prefere_a_selecao_da_request_ao_override_do_processo() {
    let routes = Arc::new(RecordingRoutes::default());
    let collector = node_collector_for_source(routes.clone(), "jackett", Some(vec!["yts".into()]));
    let mut selected = job(now_ms() + 2_000);
    selected.providers = vec!["jackett".into()];
    selected.jackett_indexers = vec!["req-idx".into()];
    collector.collect(selected).await.expect("coleta");
    let requests = routes.seen.lock().expect("requests");
    let request = requests.first().expect("uma requisição");
    assert_eq!(
        request.indexers.as_deref(),
        Some(&["req-idx".to_string()][..]),
        "seleção da request vence o JACKETT_INDEXERS do processo"
    );
}

/// Torrentio: a referência read-only roda SÓ ele (`skip_sources` das outras) e
/// não manda override de `JACKETT_INDEXERS` — a fonte consulta por IMDb.
#[tokio::test]
async fn wrapper_da_sombra_torrentio_manda_skip_sources_sem_override() {
    let routes = Arc::new(RecordingRoutes::default());
    let collector = node_collector_for_source(routes.clone(), "torrentio", None);
    collector
        .collect(job(now_ms() + 2_000))
        .await
        .expect("coleta");
    let requests = routes.seen.lock().expect("requests");
    let request = requests.first().expect("uma requisição");
    assert!(request.read_only, "sombra não pode ter efeitos no Node");
    assert_eq!(request.shadow_source.as_deref(), Some("torrentio"));
    assert_eq!(
        request.skip_sources,
        vec![
            "jackett".to_string(),
            "prowlarr".to_string(),
            "bludv".to_string(),
            "mico".to_string()
        ],
        "a referência não repete as outras fontes"
    );
    assert_eq!(
        request.indexers, None,
        "Torrentio não tem lista de JACKETT_INDEXERS"
    );
}
