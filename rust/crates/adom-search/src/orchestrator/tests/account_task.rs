//! A conta nativa entra na PRIMEIRA resposta: o inventário local não espera o
//! indexer global mais lento. A conta é uma fonte do próprio orquestrador.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use adom_debrid::account::{AccountInventory, InventoryItem};

use super::test_support::*;
use crate::orchestrator::account::{AccountInventorySource, AccountRequest};
use crate::orchestrator::finish::SearchInput;

const HASH_CONTA: &str = "dddddddddddddddddddddddddddddddddddddddd";

struct StubInventory {
    inventory: AccountInventory,
}

impl AccountInventorySource for StubInventory {
    fn inventory<'a>(
        &'a self,
        _req: AccountRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AccountInventory, String>> + Send + 'a>> {
        let inventory = self.inventory.clone();
        Box::pin(async move { Ok(inventory) })
    }
}

fn inventory() -> Arc<StubInventory> {
    Arc::new(StubInventory {
        inventory: AccountInventory {
            items: vec![InventoryItem {
                title: "Filme Teste 2024 1080p".into(),
                info_hash: HASH_CONTA.into(),
                size: 4_000_000_000.0,
                id: None,
            }],
            known: true,
            unusable: None,
        },
    })
}

fn input(deadline_ms: i64) -> SearchInput {
    let now = crate::orchestrator::respond::now_ms();
    SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: None,
        prefix: String::new(),
        options: options(),
        key: "k".into(),
        now_ms: now,
        deadline_at: Some(now + deadline_ms),
        fence: Default::default(),
    }
}

/// O global leva 3 s; a janela fecha em ~0,6 s. A conta nativa já tem que
/// estar no balde da PRIMEIRA resposta.
#[tokio::test]
async fn conta_nativa_chega_na_primeira_resposta_sem_esperar_o_global_lento() {
    let slow = StubCollector::slow(
        vec![item("1111111111111111111111111111111111111111")],
        Duration::from_secs(3),
    );
    let mut cfg = config();
    cfg.selected_indexers = vec!["globaltest".into()];
    let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_collector(slow)
        .with_meta(Arc::new(StubMeta(meta())))
        .with_account_source(inventory());

    let (items, partial, _completion, failed, _live) =
        orch.collect_scoped(&input(600), &meta(), None).await;

    assert!(partial, "o global lento estourou a janela");
    assert!(!failed, "a conta nunca conta como falha de coleta");
    assert!(
        items
            .iter()
            .any(|i| i.from_account && i.info_hash.as_deref() == Some(HASH_CONTA)),
        "item da conta ausente da 1ª resposta: {items:?}"
    );
}

/// O grupo BR sozinho (índice coberto) não ganha a conta: `scope=Some(true)`
/// poda a tarefa antes da janela.
#[tokio::test]
async fn grupo_br_prioritario_nao_coleta_a_conta() {
    let mut cfg = config();
    cfg.selected_indexers = vec!["brtest".into()];
    cfg.pt_br_indexers = vec!["brtest".into()];
    let orch = Orchestrator::new(cfg, Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_account_source(inventory());
    let (items, _partial, _completion, _failed, _live) =
        orch.collect_scoped(&input(600), &meta(), Some(true)).await;
    assert!(
        items.iter().all(|i| !i.from_account),
        "grupo prioritário não deve carregar item da conta"
    );
}
