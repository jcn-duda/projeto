//! A conta do debrid sai em tarefa PRÓPRIA: não espera o indexer global lento.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;

use super::test_support::*;
use crate::orchestrator::finish::SearchInput;

const HASH_CONTA: &str = "dddddddddddddddddddddddddddddddddddddddd";

/// Rota que só responde a coleta SÓ-da-conta (todas as fontes puladas).
struct AccountRoutes {
    requests: Mutex<Vec<CollectRequest>>,
}

impl InternalRoutes for AccountRoutes {
    fn meta<'a>(&'a self, _req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async { Err("meta não usado".into()) })
    }

    fn collect<'a>(&'a self, req: CollectRequest) -> RouteFuture<'a, CollectResponse> {
        self.requests.lock().expect("requests").push(req);
        Box::pin(async {
            serde_json::from_value(json!({
                "ok": true, "task_scope": "all", "query": "q", "imdb_id": "tt0133093",
                "partial": false,
                "items": [{"title": "Filme Teste 2024 1080p", "infoHash": HASH_CONTA,
                           "indexer": "debrid", "tracker": "AllDebrid"}],
            }))
            .map_err(|e| e.to_string())
        })
    }

    fn effects<'a>(&'a self, _req: EffectsRequest) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async { Err("não usado".into()) })
    }
}

fn input(deadline_ms: i64) -> SearchInput {
    let now = crate::orchestrator::respond::now_ms();
    SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: None,
        prefix: String::new(),
        options: json!({}),
        key: "k".into(),
        now_ms: now,
        deadline_at: Some(now + deadline_ms),
    }
}

/// O global leva 3 s; a janela fecha em ~0,5 s. A conta já tem que estar no
/// balde da PRIMEIRA resposta, e a coleta só-da-conta pula todo indexer.
#[tokio::test]
async fn conta_chega_na_primeira_resposta_sem_esperar_o_global_lento() {
    let routes = Arc::new(AccountRoutes {
        requests: Mutex::new(Vec::new()),
    });
    let slow = StubCollector::slow(
        vec![item("1111111111111111111111111111111111111111")],
        Duration::from_secs(3),
    );
    let mut cfg = config();
    cfg.selected_indexers = vec!["globaltest".into()];
    let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_collector(slow)
        .with_meta(Arc::new(StubMeta(meta())))
        .with_internal_routes(routes.clone());

    let (items, partial, _completion, failed, _live) =
        orch.collect_scoped(&input(600), &meta(), None).await;

    assert!(partial, "o global lento estourou a janela");
    assert!(!failed, "a conta nunca conta como falha de coleta");
    assert!(
        items
            .iter()
            .any(|i| i.info_hash.as_deref() == Some(HASH_CONTA)),
        "item da conta ausente da 1ª resposta: {items:?}"
    );
    let reqs = routes.requests.lock().expect("requests");
    assert_eq!(reqs.len(), 1);
    for fonte in ["jackett", "prowlarr", "torrentio", "bludv", "mico"] {
        assert!(
            reqs[0].skip_sources.iter().any(|s| s == fonte),
            "{fonte} deveria ser pulada"
        );
    }
}

/// O grupo BR sozinho (índice coberto) não ganha a tarefa da conta.
#[tokio::test]
async fn grupo_br_prioritario_nao_coleta_a_conta() {
    let routes = Arc::new(AccountRoutes {
        requests: Mutex::new(Vec::new()),
    });
    let mut cfg = config();
    cfg.selected_indexers = vec!["brtest".into()];
    cfg.pt_br_indexers = vec!["brtest".into()];
    let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_internal_routes(routes.clone());
    let _ = orch.collect_scoped(&input(600), &meta(), Some(true)).await;
    assert_eq!(routes.requests.lock().expect("requests").len(), 0);
}
