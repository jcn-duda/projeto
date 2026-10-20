//! Testes da sombra do inventário: comparação de hashes e caminhos de erro.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use adom_core::RelevanceSettings;
use adom_debrid::account::{AccountInventory, InventoryItem};
use adom_debrid::verdict::UnusableKind;
use serde_json::json;
use tokio::sync::oneshot;

use super::{compare_hashes, run};
use crate::orchestrator::account::AccountRequest;
use crate::orchestrator::account_metrics::{
    AccountMetrics, SHADOW_COMPARED, SHADOW_DIVERGENCE, SHADOW_ERROR, SHADOW_ITEMS_EXTRA,
    SHADOW_ITEMS_MISSING, SHADOW_SKIPPED, SHADOW_TIMEOUT,
};
use crate::orchestrator::meta::SearchMeta;
use crate::raw_item::RawItem;

struct StubSource {
    inventory: Result<AccountInventory, String>,
    delay: Duration,
}

impl crate::orchestrator::account::AccountInventorySource for StubSource {
    fn inventory<'a>(
        &'a self,
        _req: AccountRequest,
    ) -> Pin<Box<dyn Future<Output = Result<AccountInventory, String>> + Send + 'a>> {
        let result = self.inventory.clone();
        let delay = self.delay;
        Box::pin(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            result
        })
    }
}

fn source(inventory: Result<AccountInventory, String>) -> Arc<StubSource> {
    Arc::new(StubSource {
        inventory,
        delay: Duration::ZERO,
    })
}

fn meta(names: &[&str]) -> SearchMeta {
    SearchMeta {
        imdb_id: "tt0133093".into(),
        names: names.iter().map(|name| name.to_string()).collect(),
        year: json!(1999),
        query: "Matrix 1999".into(),
        ..SearchMeta::default()
    }
}

fn settings() -> RelevanceSettings {
    RelevanceSettings {
        now_ms: 1_700_000_000_000,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: 48 * 3_600_000,
        title_precision_tail_cut: true,
    }
}

fn inventory(items: &[(&str, &str)]) -> AccountInventory {
    AccountInventory {
        items: items
            .iter()
            .map(|(title, hash)| InventoryItem {
                title: (*title).to_string(),
                info_hash: (*hash).to_string(),
                size: 1_000_000_000.0,
                id: None,
            })
            .collect(),
        known: true,
        unusable: None,
    }
}

fn node_items(hashes: &[&str]) -> Vec<RawItem> {
    hashes
        .iter()
        .map(|hash| RawItem {
            info_hash: Some((*hash).to_string()),
            title: Some("Matrix Dublado 1080p".into()),
            from_account: true,
            ..RawItem::default()
        })
        .collect()
}

fn req() -> AccountRequest {
    AccountRequest {
        service: "alldebrid".into(),
        api_key: "chave-de-teste".into(),
    }
}

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccc";

#[tokio::test]
async fn par_identico_nao_diverge() {
    let metrics = AccountMetrics::new();
    let (tx, rx) = oneshot::channel();
    tx.send(Ok(node_items(&[HASH_A, HASH_B]))).expect("envio");
    let native = source(Ok(inventory(&[
        ("Matrix Dublado 1080p", HASH_A),
        ("Matrix Dublado 720p", HASH_B),
    ])));
    run(
        native,
        req(),
        "AllDebrid".into(),
        meta(&["Matrix"]),
        settings(),
        rx,
        Duration::from_millis(200),
        metrics.clone(),
    )
    .await;
    assert_eq!(metrics.get(SHADOW_COMPARED), 1);
    assert_eq!(metrics.get(SHADOW_DIVERGENCE), 0);
}

#[tokio::test]
async fn faltando_e_sobrando_contam_divergencia() {
    let metrics = AccountMetrics::new();
    let (tx, rx) = oneshot::channel();
    // Node tem o C que o nativo não tem; nativo tem o B que o Node não tem.
    tx.send(Ok(node_items(&[HASH_A, HASH_C]))).expect("envio");
    let native = source(Ok(inventory(&[
        ("Matrix Dublado 1080p", HASH_A),
        ("Matrix Dublado 720p", HASH_B),
    ])));
    run(
        native,
        req(),
        "AllDebrid".into(),
        meta(&["Matrix"]),
        settings(),
        rx,
        Duration::from_millis(200),
        metrics.clone(),
    )
    .await;
    assert_eq!(metrics.get(SHADOW_COMPARED), 1);
    assert_eq!(metrics.get(SHADOW_DIVERGENCE), 1);
    assert_eq!(metrics.get(SHADOW_ITEMS_MISSING), 1);
    assert_eq!(metrics.get(SHADOW_ITEMS_EXTRA), 1);
}

#[tokio::test]
async fn nativo_sem_veredito_conta_skipped() {
    let metrics = AccountMetrics::new();
    let (tx, rx) = oneshot::channel();
    tx.send(Ok(node_items(&[HASH_A]))).expect("envio");
    let mut unknown = inventory(&[("Matrix Dublado 1080p", HASH_A)]);
    unknown.known = false;
    unknown.unusable = Some((UnusableKind::Quota, "limite".into()));
    run(
        source(Ok(unknown)),
        req(),
        "AllDebrid".into(),
        meta(&["Matrix"]),
        settings(),
        rx,
        Duration::from_millis(200),
        metrics.clone(),
    )
    .await;
    assert_eq!(metrics.get(SHADOW_SKIPPED), 1);
    assert_eq!(metrics.get(SHADOW_COMPARED), 0);
    assert_eq!(metrics.get(SHADOW_DIVERGENCE), 0);
}

#[tokio::test]
async fn erro_do_node_conta_error() {
    let metrics = AccountMetrics::new();
    let (tx, rx) = oneshot::channel();
    tx.send(Err("rota falhou".into())).expect("envio");
    run(
        source(Ok(inventory(&[("Matrix Dublado 1080p", HASH_A)]))),
        req(),
        "AllDebrid".into(),
        meta(&["Matrix"]),
        settings(),
        rx,
        Duration::from_millis(200),
        metrics.clone(),
    )
    .await;
    assert_eq!(metrics.get(SHADOW_ERROR), 1);
    assert_eq!(metrics.get(SHADOW_COMPARED), 0);
}

#[tokio::test]
async fn timeout_da_leitura_conta_timeout() {
    let metrics = AccountMetrics::new();
    let (tx, rx) = oneshot::channel();
    tx.send(Ok(node_items(&[HASH_A]))).expect("envio");
    let native = Arc::new(StubSource {
        inventory: Ok(inventory(&[("Matrix Dublado 1080p", HASH_A)])),
        delay: Duration::from_millis(60),
    });
    run(
        native,
        req(),
        "AllDebrid".into(),
        meta(&["Matrix"]),
        settings(),
        rx,
        Duration::from_millis(5),
        metrics.clone(),
    )
    .await;
    assert_eq!(metrics.get(SHADOW_TIMEOUT), 1);
    assert_eq!(metrics.get(SHADOW_COMPARED), 0);
}

#[test]
fn compare_hashes_e_diferenca_simetrica() {
    let native = node_items(&[HASH_A, HASH_B]);
    let node = node_items(&[HASH_B, HASH_C]);
    assert_eq!(compare_hashes(&native, &node), (1, 1));
    assert_eq!(compare_hashes(&native, &native), (0, 0));
    // Hash vazio não entra em nenhum conjunto.
    let empty = vec![RawItem::default()];
    assert_eq!(compare_hashes(&empty, &empty), (0, 0));
}
