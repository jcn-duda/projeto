use super::*;
use crate::internal_types::TaskScope;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct TestCollector {
    items: Vec<RawItem>,
    partial: bool,
    fail: bool,
    live: Option<LiveBatchState>,
    calls: Arc<AtomicUsize>,
}

impl TestCollector {
    fn sem_estado(items: Vec<RawItem>, calls: Arc<AtomicUsize>) -> Arc<Self> {
        Arc::new(TestCollector {
            items,
            partial: false,
            fail: false,
            live: None,
            calls,
        })
    }
}

impl Collector for TestCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let items = self.items.clone();
        let partial = self.partial;
        let fail = self.fail;
        let live = self.live.clone();
        Box::pin(async move {
            if fail {
                Err("falha simulada".into())
            } else {
                Ok(CollectBatch {
                    items,
                    partial,
                    live,
                })
            }
        })
    }
}

fn test_job() -> CollectJob {
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
        deadline_at: 1_700_000_000_000,
        late_sweep: false,
        providers: Vec::new(),
        jackett_indexers: Vec::new(),
        dubbed_only: false,
        mico_default: false,
    }
}

#[tokio::test]
async fn composite_combina_itens_de_multiplos_coletores() {
    let calls1 = Arc::new(AtomicUsize::new(0));
    let c1 = Arc::new(TestCollector {
        items: vec![RawItem {
            indexer: Some("jackett".into()),
            title: Some("Matrix 1".into()),
            ..RawItem::default()
        }],
        partial: false,
        fail: false,
        live: None,
        calls: calls1.clone(),
    });

    let calls2 = Arc::new(AtomicUsize::new(0));
    let c2 = Arc::new(TestCollector {
        items: vec![RawItem {
            indexer: Some("bludv".into()),
            title: Some("Matrix Dublado".into()),
            is_br: true,
            ..RawItem::default()
        }],
        partial: false,
        fail: false,
        live: None,
        calls: calls2.clone(),
    });

    let composite = CompositeCollector::new(vec![c1, c2]);
    let batch = composite.collect(test_job()).await.expect("ok");

    assert_eq!(batch.items.len(), 2);
    assert_eq!(calls1.load(Ordering::SeqCst), 1);
    assert_eq!(calls2.load(Ordering::SeqCst), 1);
    assert!(!batch.partial);
    assert!(batch
        .items
        .iter()
        .any(|i| i.indexer.as_deref() == Some("jackett")));
    assert!(batch
        .items
        .iter()
        .any(|i| i.indexer.as_deref() == Some("bludv")));
}

#[tokio::test]
async fn composite_propaga_partial_se_qualquer_um_for_partial() {
    let calls = Arc::new(AtomicUsize::new(0));
    let c1 = Arc::new(TestCollector {
        items: vec![],
        partial: true,
        fail: false,
        live: None,
        calls: calls.clone(),
    });
    let c2 = Arc::new(TestCollector {
        items: vec![RawItem {
            indexer: Some("node".into()),
            ..RawItem::default()
        }],
        partial: false,
        fail: false,
        live: None,
        calls: calls.clone(),
    });

    let composite = CompositeCollector::new(vec![c1, c2]);
    let batch = composite.collect(test_job()).await.expect("ok");
    assert!(batch.partial);
    assert_eq!(batch.items.len(), 1);
}

#[tokio::test]
async fn composite_propaga_partial_se_um_coletor_falhar() {
    let calls = Arc::new(AtomicUsize::new(0));
    let c1 = Arc::new(TestCollector {
        items: vec![],
        partial: false,
        fail: true,
        live: None,
        calls: calls.clone(),
    });
    let c2 = Arc::new(TestCollector {
        items: vec![RawItem {
            indexer: Some("jackett".into()),
            ..RawItem::default()
        }],
        partial: false,
        fail: false,
        live: None,
        calls: calls.clone(),
    });

    let composite = CompositeCollector::new(vec![c1, c2]);
    let batch = composite.collect(test_job()).await.expect("ok");
    assert!(
        batch.partial,
        "falha parcial deve marcar batch.partial = true"
    );
    assert_eq!(batch.items.len(), 1);
}

// ── Estado vivo composto ────────────────────────────────────────────────

fn state(failed: &[&str], pending: &[&str], empty: &[&str], all: &str) -> LiveBatchState {
    LiveBatchState {
        failed: failed.iter().map(|s| s.to_string()).collect(),
        pending: pending.iter().map(|s| s.to_string()).collect(),
        empty: empty.iter().map(|s| s.to_string()).collect(),
        all: match all {
            "ok" => crate::orchestrator::live_state::LiveAllState::Ok,
            "error" => crate::orchestrator::live_state::LiveAllState::Error,
            "pending" => crate::orchestrator::live_state::LiveAllState::Pending,
            _ => crate::orchestrator::live_state::LiveAllState::Unknown,
        },
    }
}

/// Falha de UM coletor com sucesso de outro: o estado fundido mantém a
/// falha registrada e o agregado do que respondeu — sucesso não apaga.
#[tokio::test]
async fn composite_funde_estado_e_sucesso_nao_apaga_falha() {
    let calls = Arc::new(AtomicUsize::new(0));
    let nativo = Arc::new(TestCollector {
        items: vec![RawItem {
            indexer: Some("jackett".into()),
            ..RawItem::default()
        }],
        partial: false,
        fail: false,
        live: Some(state(&["jackett"], &[], &[], "ok")),
        calls: calls.clone(),
    });
    let node = Arc::new(TestCollector {
        items: vec![RawItem {
            indexer: Some("bludv".into()),
            ..RawItem::default()
        }],
        partial: false,
        fail: false,
        live: Some(state(&[], &["torrentio"], &[], "ok")),
        calls: calls.clone(),
    });

    let batch = CompositeCollector::new(vec![nativo, node])
        .collect(test_job())
        .await
        .expect("ok");
    let live = batch.live.expect("contrato vivo fundido");
    assert!(live.failed.contains("jackett"), "falha sobrevive à fusão");
    assert!(live.pending.contains("torrentio"));
    assert!(!live.suspect_indexers().contains("jackett"));
    assert_eq!(batch.items.len(), 2);
}

/// Ponte até F2: lote bem-sucedido SEM contrato vivo (coletor nativo
/// fail-open) não pode sumir da fusão. Com o `ok` do Node ao lado, o composto
/// vira `error` sem inventar nomes e preserva 📦/selos dos nativos não citados.
#[tokio::test]
async fn composite_lote_sem_live_vira_falha_desconhecida_conservadora() {
    let calls = Arc::new(AtomicUsize::new(0));
    let nativo = TestCollector::sem_estado(
        vec![RawItem {
            indexer: Some("jackett".into()),
            ..RawItem::default()
        }],
        calls.clone(),
    );
    let node = Arc::new(TestCollector {
        items: vec![],
        partial: false,
        fail: false,
        live: Some(state(&["bludv"], &[], &[], "ok")),
        calls: calls.clone(),
    });

    let batch = CompositeCollector::new(vec![nativo, node])
        .collect(test_job())
        .await
        .expect("ok");
    let live = batch
        .live
        .expect("lote sem contrato nunca vira sucesso silencioso");
    assert!(live.all.failed(), "agregado conservador");
    assert!(live.has_any_failure());
    assert!(live.failed.contains("bludv"), "estado do Node preservado");
    assert_eq!(live.failed.len(), 1, "não inventa indexer nativo");
    assert!(live.pending.is_empty() && live.empty.is_empty());

    // Sem NENHUM contrato: também vira desconhecida, nunca `None`/"respondeu".
    let calls2 = Arc::new(AtomicUsize::new(0));
    let a = TestCollector::sem_estado(
        vec![RawItem {
            indexer: Some("x".into()),
            ..RawItem::default()
        }],
        calls2.clone(),
    );
    let b = TestCollector::sem_estado(
        vec![RawItem {
            indexer: Some("y".into()),
            ..RawItem::default()
        }],
        calls2.clone(),
    );
    let batch = CompositeCollector::new(vec![a, b])
        .collect(test_job())
        .await
        .expect("ok");
    let live = batch.live.expect("ponte conservadora até F2");
    assert!(live.all.failed());
    assert!(live.failed.is_empty() && live.pending.is_empty() && live.empty.is_empty());
}

/// Node puro (todos os subcoletores com contrato) segue a fusão normal: o
/// agregado `ok` não vira `error` por causa da ponte acima.
#[tokio::test]
async fn composite_node_puro_continua_normal() {
    let calls = Arc::new(AtomicUsize::new(0));
    let a = Arc::new(TestCollector {
        items: vec![],
        partial: false,
        fail: false,
        live: Some(state(&[], &["mico"], &[], "ok")),
        calls: calls.clone(),
    });
    let b = Arc::new(TestCollector {
        items: vec![],
        partial: false,
        fail: false,
        live: Some(state(&[], &[], &["hdr"], "ok")),
        calls: calls.clone(),
    });

    let batch = CompositeCollector::new(vec![a, b])
        .collect(test_job())
        .await
        .expect("ok");
    let live = batch.live.expect("estado do Node");
    assert_eq!(live.all, crate::orchestrator::live_state::LiveAllState::Ok);
    assert!(
        live.has_any_failure(),
        "pending conta como indisponível, como no Node"
    );
    assert!(live.pending.contains("mico"));
    assert!(live.suspect_indexers().contains("hdr"));
}

/// Coletor que ERRA não vira indexer nomeado nem inventa falha por indexer,
/// mas o lote composto NÃO pode sair como "respondeu": o agregado fica
/// `error` (estado conservador) e preserva 📦/selos do que dependia dele.
#[tokio::test]
async fn composite_erro_individual_preserva_estado_conservador() {
    let calls = Arc::new(AtomicUsize::new(0));
    let quebrado = Arc::new(TestCollector {
        items: vec![],
        partial: false,
        fail: true,
        live: None,
        calls: calls.clone(),
    });
    let node = Arc::new(TestCollector {
        items: vec![RawItem {
            indexer: Some("bludv".into()),
            ..RawItem::default()
        }],
        partial: false,
        fail: false,
        live: Some(state(&[], &[], &[], "ok")),
        calls: calls.clone(),
    });

    let batch = CompositeCollector::new(vec![quebrado, node])
        .collect(test_job())
        .await
        .expect("ok");
    assert!(batch.partial);
    let live = batch.live.expect("estado conservador sintetizado");
    assert!(live.failed.is_empty() && live.pending.is_empty());
    assert!(
        live.all.failed(),
        "erro de transporte não vira sucesso: agregado conservador"
    );
    assert_eq!(batch.items.len(), 1, "itens do que respondeu ficam");
}

/// O estado conservador também aparece quando NENHUM subcoletor trouxe
/// contrato vivo: antes o lote saía `live: None`, indistinguível de sucesso.
#[tokio::test]
async fn composite_erro_individual_sem_contrato_nao_vira_none() {
    let calls = Arc::new(AtomicUsize::new(0));
    let quebrado = Arc::new(TestCollector {
        items: vec![],
        partial: false,
        fail: true,
        live: None,
        calls: calls.clone(),
    });
    let sem_estado = TestCollector::sem_estado(
        vec![RawItem {
            indexer: Some("bludv".into()),
            ..RawItem::default()
        }],
        calls.clone(),
    );

    let batch = CompositeCollector::new(vec![quebrado, sem_estado])
        .collect(test_job())
        .await
        .expect("ok");
    let live = batch.live.expect("falha isolada não pode sumir");
    assert!(live.all.failed());
    assert!(live.has_any_failure());
}
