//! Sombra de FONTE do Mico (C4) — recorte pela catraca de 400 linhas.
//!
//! Diferente de Prowlarr/Torrentio, o Node **emite `live` para o Mico** no
//! `collectRawLive` (`noteStart(["mico"])` + `onQueryResult`). Por isso o par
//! entra com `compare_live:true` e o `live_divergence` cobre
//! `ok`/`empty`/`failed`/`pending` dos dois lados. `all` continua `Unknown`
//! (Mico não tem ramo `/all`), então nunca vira divergência.

use adom_sources::now_ms;

use super::test_support::{batch, item, job, live, stub, stub_ref};
use super::*;
use crate::orchestrator::live_state::LiveAllState;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GATO: &str = "mico";

fn mico_batch(failed: &[&str], pending: &[&str], empty: &[&str]) -> CollectBatch {
    batch(
        vec![],
        false,
        Some(live(failed, pending, empty, LiveAllState::Unknown)),
    )
}

#[test]
fn mico_compara_live_ok() {
    let native = mico_batch(&[], &[], &[]);
    let node = mico_batch(&[], &[], &[]);
    let comparison = compare_batches(&native, &node);
    assert!(!comparison.live_divergence);
    assert!(!comparison.diverged());
}

#[test]
fn mico_live_divergence_em_empty_failed_e_pending() {
    // Vazio suspeito só de um lado.
    let node_empty = mico_batch(&[], &[], &[GATO]);
    assert!(
        compare_batches(&mico_batch(&[], &[], &[]), &node_empty).live_divergence,
        "Node empty × nativo ok diverge"
    );
    assert!(
        compare_batches(&node_empty, &mico_batch(&[], &[], &[])).live_divergence,
        "nativo empty × Node ok diverge"
    );

    // Falha viva só de um lado.
    let node_failed = mico_batch(&[GATO], &[], &[]);
    assert!(compare_batches(&mico_batch(&[], &[], &[]), &node_failed).live_divergence);
    assert!(compare_batches(&node_failed, &mico_batch(&[], &[], &[])).live_divergence);
    assert!(
        !compare_batches(&node_failed, &node_failed.clone()).live_divergence,
        "falha igual dos dois lados não diverge"
    );

    // `pending` é o estado que o Node realmente usa para o Mico: os DOIS lados
    // pendentes concordam; um lado pendente contra ok/failed diverge.
    let node_pending = mico_batch(&[], &[GATO], &[]);
    assert!(
        !compare_batches(&node_pending, &node_pending.clone()).live_divergence,
        "pending dos dois lados concorda"
    );
    assert!(
        compare_batches(&node_pending, &mico_batch(&[], &[], &[])).live_divergence,
        "Node pending × nativo ok diverge"
    );
    assert!(
        compare_batches(&mico_batch(&[], &[], &[]), &node_pending).live_divergence,
        "nativo ok × Node pending diverge"
    );
    assert!(
        compare_batches(&node_pending, &node_failed).live_divergence,
        "pending × failed é divergência"
    );

    let metrics = SourceShadowMetrics::new();
    record_comparison("mico", &mico_batch(&[], &[], &[]), &node_pending, &metrics);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 1);
    assert_eq!(metrics.get(DIVERGENCE), 1);
}

#[test]
fn mico_all_unknown_nao_e_divergencia() {
    // O agregado `/all` não existe no Mico: um lado `Ok` (hipotético) e o
    // outro `Unknown` NÃO podem divergir, como no `live_differs`.
    let native = batch(vec![], false, Some(live(&[], &[], &[], LiveAllState::Ok)));
    let node = mico_batch(&[], &[], &[]);
    assert!(!compare_batches(&native, &node).live_divergence);
}

/// A identidade do Mico é `indexer:"mico"` + hash normalizado; hash a mais/a
/// menos conta como divergência mesmo com o live igual.
#[test]
fn mico_compara_hash_por_indexer() {
    let node = batch(
        vec![item("mico", HASH_B)],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    let native = batch(
        vec![item(" mico ", HASH_A)],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    let metrics = SourceShadowMetrics::new();
    let comparison = record_comparison("mico", &native, &node, &metrics);
    assert_eq!(comparison.missing_count, 1, "hash só no Node");
    assert_eq!(comparison.extra_count, 1, "hash só no nativo");
    assert!(comparison.missing.contains_key("mico"));
    assert_eq!(metrics.get(DIVERGENCE), 1);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);

    // Mesma identidade normalizada (case/trim) não diverge.
    let igual = batch(
        vec![item("MICO", &HASH_A.to_uppercase())],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    assert!(!compare_batches(&native, &igual).diverged());
}

/// `compare_live:true` é o que o `native_collector("mico")` arma: o Node
/// promete o contrato vivo para esta fonte.
#[tokio::test]
async fn mico_par_elegivel_compare_live_true() {
    let metrics = SourceShadowMetrics::new();
    let state = live(&[], &[], &[GATO], LiveAllState::Unknown);
    let native = stub(
        Ok(batch(
            vec![item("mico", HASH_A)],
            false,
            Some(state.clone()),
        )),
        0,
    );
    let node = stub_ref(
        Ok((batch(vec![item("mico", HASH_A)], false, Some(state)), true)),
        0,
    );
    let pair = ShadowPair {
        source: "mico",
        native,
        node,
        compare_live: true,
    };
    run_pair(pair, job(now_ms() + 1_000), metrics.clone()).await;
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
}

/// Fonte fora da seleção (`ji` sem o card e `MICO_DEFAULT=false`): a
/// referência read-only devolve `eligible:false` e o par é pulado, sem
/// `compared`/`divergence` — o vazio proposital não é divergência.
#[tokio::test]
async fn mico_skipped_quando_fora_da_selecao() {
    let metrics = SourceShadowMetrics::new();
    let native = stub(
        Ok(batch(
            vec![],
            false,
            Some(live(&[], &[], &[], LiveAllState::Unknown)),
        )),
        0,
    );
    let node = stub_ref(
        Ok((
            batch(
                vec![],
                false,
                Some(live(&[], &[], &[], LiveAllState::Unknown)),
            ),
            false,
        )),
        0,
    );
    let pair = ShadowPair {
        source: "mico",
        native,
        node,
        compare_live: true,
    };
    run_pair(pair, job(now_ms() + 1_000), metrics.clone()).await;
    assert_eq!(metrics.get(SKIPPED), 1);
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
}
