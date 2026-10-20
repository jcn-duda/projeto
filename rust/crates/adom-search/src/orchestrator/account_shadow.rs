//! Sombra do inventário da conta (`ACCOUNT_RUST=shadow`): nativo × Node.
//!
//! O nativo e o Node rodam em paralelo e a comparação acontece DEPOIS que a
//! tarefa Node primária resolve — o cliente nunca espera a sombra. A amostra é
//! determinística por obra ([`super::account::sampled`]); requisição fora da
//! amostra não lê o inventário nativo e conta só `account.shadow.not_sampled`.
//!
//! O que é comparado: o lote que vira fonte (`account.search`), ou seja, o
//! inventário DEPOIS do `filterInventoryRelevant` — a mesma unidade que o build
//! consome. Comparar o inventário cru exigiria uma rota nova no Node (o
//! `collect` devolve o lote já filtrado), então a contagem/hash aqui mede o
//! contrato inteiro da F3 (leitura + filtro), não só o HTTP.
//!
//! `known:false`/`unusable` NÃO é divergência de fonte: é o nativo sem
//! resposta, contado em `skipped`. Falha de transporte conta em `error` e
//! estouro do teto em `timeout` — os dois nunca somam em `divergence`.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use adom_core::RelevanceSettings;
use tokio::sync::oneshot;

use crate::raw_item::RawItem;

use super::account::{account_raw_items, AccountInventorySource, AccountRequest};
use super::account_metrics::{self as metrics, AccountMetrics};
use super::meta::SearchMeta;

/// Roda a comparação em fundo. `node_rx` é preenchido pela tarefa Node
/// primária com o lote dela (ou o erro) — nenhuma segunda chamada ao Node.
#[allow(clippy::too_many_arguments)]
pub fn spawn_shadow_compare(
    native: Arc<dyn AccountInventorySource>,
    req: AccountRequest,
    label: String,
    meta: SearchMeta,
    settings: RelevanceSettings,
    node_rx: oneshot::Receiver<Result<Vec<RawItem>, String>>,
    timeout: Duration,
) {
    let metrics = metrics::global_metrics().clone();
    tokio::spawn(async move {
        run(
            native, req, label, meta, settings, node_rx, timeout, metrics,
        )
        .await;
    });
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn run(
    native: Arc<dyn AccountInventorySource>,
    req: AccountRequest,
    label: String,
    meta: SearchMeta,
    settings: RelevanceSettings,
    node_rx: oneshot::Receiver<Result<Vec<RawItem>, String>>,
    timeout: Duration,
    metrics: AccountMetrics,
) {
    let native_items = match tokio::time::timeout(timeout, native.inventory(req)).await {
        Ok(Ok(inventory)) => {
            if !inventory.known {
                // Sem resposta conhecida (rede/prazo/auth/quota): não há par.
                metrics.inc(metrics::SHADOW_SKIPPED, 1);
                eprintln!("[account-shadow] leitura nativa sem veredito; par pulado");
                return;
            }
            account_raw_items(&inventory.items, &meta, settings, &label)
        }
        Ok(Err(err)) => {
            metrics.inc(metrics::SHADOW_ERROR, 1);
            eprintln!("[account-shadow] fonte nativa indisponível: {err}");
            return;
        }
        Err(_) => {
            metrics.inc(metrics::SHADOW_TIMEOUT, 1);
            eprintln!("[account-shadow] leitura nativa estourou {timeout:?}");
            return;
        }
    };
    let node_items = match node_rx.await {
        Ok(Ok(items)) => items,
        Ok(Err(err)) => {
            metrics.inc(metrics::SHADOW_ERROR, 1);
            eprintln!("[account-shadow] referência Node falhou: {err}");
            return;
        }
        Err(_) => {
            // A tarefa Node foi abortada/dropada antes de entregar o lote.
            metrics.inc(metrics::SHADOW_ERROR, 1);
            return;
        }
    };
    let (missing, extra) = compare_hashes(&native_items, &node_items);
    metrics.inc(metrics::SHADOW_COMPARED, 1);
    if missing > 0 || extra > 0 || native_items.len() != node_items.len() {
        metrics.inc(metrics::SHADOW_DIVERGENCE, 1);
        metrics.inc(metrics::SHADOW_ITEMS_MISSING, missing as u64);
        metrics.inc(metrics::SHADOW_ITEMS_EXTRA, extra as u64);
        eprintln!(
            "[account-shadow] divergência: nativo={} node={} faltando_no_nativo={} sobrando_no_nativo={}",
            native_items.len(),
            node_items.len(),
            missing,
            extra
        );
    }
}

/// Diferença simétrica de hashes: `(faltando no nativo, sobrando no nativo)`.
pub fn compare_hashes(native: &[RawItem], node: &[RawItem]) -> (usize, usize) {
    let native_set: BTreeSet<String> = native
        .iter()
        .map(RawItem::bank_hash)
        .filter(|hash| !hash.is_empty())
        .collect();
    let node_set: BTreeSet<String> = node
        .iter()
        .map(RawItem::bank_hash)
        .filter(|hash| !hash.is_empty())
        .collect();
    let missing = node_set.difference(&native_set).count();
    let extra = native_set.difference(&node_set).count();
    (missing, extra)
}

#[cfg(test)]
#[path = "account_shadow_tests.rs"]
mod account_shadow_tests;
