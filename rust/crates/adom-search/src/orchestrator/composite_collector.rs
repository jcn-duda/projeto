//! Coletor composto: combina collectors nativos (Rust) com o `NodeCollector`.
//!
//! Permite que fontes migradas para Rust (ex.: Jackett, Torrentio) rodem nativamente
//! enquanto fontes não migradas e o inventário da conta continuam sendo colhidos
//! via `NodeCollector` (`POST /internal/search/collect`).
//!
//! Os lotes são somados em paralelo, preservando os itens por indexer.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::collect::{CollectBatch, CollectJob, Collector};
use crate::raw_item::RawItem;

/// Coletor que executa múltiplos collectors em paralelo e funde os lotes.
pub struct CompositeCollector {
    collectors: Vec<Arc<dyn Collector>>,
}

impl CompositeCollector {
    pub fn new(collectors: Vec<Arc<dyn Collector>>) -> Self {
        Self { collectors }
    }

    pub fn is_empty(&self) -> bool {
        self.collectors.is_empty()
    }

    pub fn len(&self) -> usize {
        self.collectors.len()
    }
}

impl Collector for CompositeCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            if self.collectors.is_empty() {
                return Ok(CollectBatch::default());
            }

            let mut handles = Vec::with_capacity(self.collectors.len());
            for collector in &self.collectors {
                let c = collector.clone();
                let j = job.clone();
                handles.push(tokio::spawn(async move { c.collect(j).await }));
            }

            let mut all_items: Vec<RawItem> = Vec::new();
            let mut partial = false;
            let mut errors = Vec::new();

            for handle in handles {
                match handle.await {
                    Ok(Ok(batch)) => {
                        if batch.partial {
                            partial = true;
                        }
                        all_items.extend(batch.items);
                    }
                    Ok(Err(err)) => {
                        // Coletor individual falhou: a coleta combinada fica parcial
                        partial = true;
                        errors.push(err);
                    }
                    Err(join_err) => {
                        partial = true;
                        errors.push(format!("tarefa de coleta cancelada: {join_err}"));
                    }
                }
            }

            // Se todos falharam, devolve erro
            if !errors.is_empty() && all_items.is_empty() && errors.len() == self.collectors.len() {
                return Err(format!(
                    "todos os coletores falharam: {}",
                    errors.join("; ")
                ));
            }

            Ok(CollectBatch {
                items: all_items,
                partial,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::internal_types::TaskScope;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestCollector {
        items: Vec<RawItem>,
        partial: bool,
        fail: bool,
        calls: Arc<AtomicUsize>,
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
            Box::pin(async move {
                if fail {
                    Err("falha simulada".into())
                } else {
                    Ok(CollectBatch { items, partial })
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
            calls: calls.clone(),
        });
        let c2 = Arc::new(TestCollector {
            items: vec![RawItem {
                indexer: Some("node".into()),
                ..RawItem::default()
            }],
            partial: false,
            fail: false,
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
            calls: calls.clone(),
        });
        let c2 = Arc::new(TestCollector {
            items: vec![RawItem {
                indexer: Some("jackett".into()),
                ..RawItem::default()
            }],
            partial: false,
            fail: false,
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
}
