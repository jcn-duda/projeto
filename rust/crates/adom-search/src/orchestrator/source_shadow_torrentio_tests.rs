//! Sombra de FONTE do Torrentio (F2.3) — recorte do `source_shadow_tests.rs`
//! pela catraca de 400 linhas.
//!
//! O Node NÃO emite `live` para o Torrentio (`collectRawLive` só alimenta o
//! estado vivo no Jackett e no Mico; o `torrentio.search` não tem
//! `onQueryResult`). Por isso o par entra com `compare_live:false`: só a
//! IDENTIDADE (`indexer:"torrentio"` + hash) é comparada. O `live` nativo vale
//! na produção com `SOURCES_RUST=torrentio`.

use adom_sources::now_ms;

use super::test_support::{batch, item, job, live, stub, stub_ref};
use super::*;
use crate::orchestrator::live_state::LiveAllState;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// O Node não emite `live` para o Torrentio: comparar o live nativo (por
/// fonte) com o snapshot vazio da referência daria divergência FALSA.
#[test]
fn torrentio_nao_compara_live_sem_contrato_do_node() {
    let native = batch(
        vec![item("torrentio", HASH_A)],
        false,
        Some(live(&["torrentio"], &[], &[], LiveAllState::Unknown)),
    );
    let node = batch(
        vec![item("torrentio", HASH_A)],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    // Com a régua do Jackett (compare_live = true) o live divergiria…
    assert!(
        compare_batches(&native, &node).live_divergence,
        "o snapshot vazio do Node não atesta nada do Torrentio"
    );
    // …mas o par do Torrentio desliga essa comparação: mesmos hashes, sem
    // divergência de fonte.
    let comparison = compare_batches_opts(&native, &node, false);
    assert!(!comparison.live_divergence);
    assert!(!comparison.diverged());

    let metrics = SourceShadowMetrics::new();
    record_comparison_opts("torrentio", &native, &node, &metrics, false);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
}

/// A sombra do Torrentio compara a IDENTIDADE: hash a mais/a menos conta como
/// divergência, mesmo com `compare_live:false`.
#[test]
fn torrentio_compara_hash_por_indexer() {
    let native = batch(
        vec![item("torrentio", HASH_A)],
        false,
        Some(live(&[], &[], &["torrentio"], LiveAllState::Unknown)),
    );
    let node = batch(
        vec![item("torrentio", HASH_B)],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    let metrics = SourceShadowMetrics::new();
    let comparison = record_comparison_opts("torrentio", &native, &node, &metrics, false);
    assert_eq!(comparison.missing_count, 1);
    assert_eq!(comparison.extra_count, 1);
    assert!(comparison.missing.contains_key("torrentio"));
    assert_eq!(metrics.get(DIVERGENCE), 1);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
}

/// Fonte fora dos `providers` efetivos: a referência read-only devolve
/// `eligible:false` e o par é pulado (sem compared/divergence).
#[tokio::test]
async fn torrentio_skipped_quando_fora_da_selecao() {
    let metrics = SourceShadowMetrics::new();
    let native = stub(
        Ok(batch(
            vec![item("torrentio", HASH_A)],
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
        source: "torrentio",
        native,
        node,
        compare_live: false,
    };
    run_pair(pair, job(now_ms() + 1_000), metrics.clone()).await;
    assert_eq!(metrics.get(SKIPPED), 1);
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
}

/// Par elegível com os mesmos hashes: compara e NÃO conta divergência (o live
/// nativo, mesmo com falha, fica de fora).
#[tokio::test]
async fn torrentio_par_elegivel_compara_sem_divergencia() {
    let metrics = SourceShadowMetrics::new();
    let state = live(&[], &[], &[], LiveAllState::Unknown);
    let native = stub(
        Ok(batch(
            vec![item("torrentio", HASH_A)],
            false,
            Some(state.clone()),
        )),
        0,
    );
    let node = stub_ref(
        Ok((
            batch(vec![item("torrentio", HASH_A)], false, Some(state)),
            true,
        )),
        0,
    );
    let pair = ShadowPair {
        source: "torrentio",
        native,
        node,
        compare_live: false,
    };
    run_pair(pair, job(now_ms() + 1_000), metrics.clone()).await;
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(ITEMS_MISSING), 0);
    assert_eq!(metrics.get(ITEMS_EXTRA), 0);
}
