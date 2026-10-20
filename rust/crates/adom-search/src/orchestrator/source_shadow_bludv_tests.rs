//! Sombra de FONTE do BLUDV (F2.5) — recorte do `source_shadow_tests.rs`.
//!
//! O Node NÃO emite `live` para o BLUDV (`collectRawLive` só alimenta o estado
//! vivo no Jackett e no Mico; o `bludv.search` não tem `onQueryResult`). Por
//! isso o par entra com `compare_live:false`: só a IDENTIDADE é comparada. O
//! item cru do BLUDV não tem `indexer`, só `tracker: "BLUDV"`; a chave do
//! conjunto nasce dele (`_indexer` do build) — igual à rota do Node, que agrupa
//! por `indexer || tracker`.
//!
//! O `live` nativo (ok/empty/failed, `all=Unknown`, sem `pending`) vale na
//! produção com `SOURCES_RUST=bludv`.

use adom_sources::now_ms;

use super::test_support::{batch, job, live, stub, stub_ref};
use super::*;
use crate::orchestrator::live_state::LiveAllState;
use crate::raw_item::RawItem;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Item no shape do cru do BLUDV: `tracker: "BLUDV"`, sem `indexer`/`sources`.
fn bludv_item(hash: &str) -> RawItem {
    RawItem {
        title: Some("Matrix 1999 [1080p WEB-DL DUBLADO]".into()),
        magnet: Some(format!("magnet:?xt=urn:btih:{hash}&dn=x")),
        seeders: Some(1.0),
        tracker: Some("BLUDV".into()),
        is_br: true,
        ..RawItem::default()
    }
}

/// O Node não emite `live` para o BLUDV: comparar o live nativo (por fonte)
/// com o snapshot vazio da referência daria divergência FALSA.
#[test]
fn bludv_nao_compara_live_sem_contrato_do_node() {
    let native = batch(
        vec![bludv_item(HASH_A)],
        false,
        Some(live(&["bludv"], &[], &[], LiveAllState::Unknown)),
    );
    let node = batch(
        vec![bludv_item(HASH_A)],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    // Com a régua do Jackett (compare_live = true) o live divergiria…
    assert!(
        compare_batches(&native, &node).live_divergence,
        "o snapshot vazio do Node não atesta nada do BLUDV"
    );
    // …mas o par do BLUDV desliga essa comparação: mesmos hashes, sem
    // divergência de fonte.
    let comparison = compare_batches_opts(&native, &node, false);
    assert!(!comparison.live_divergence);
    assert!(!comparison.diverged());

    let metrics = SourceShadowMetrics::new();
    record_comparison_opts("bludv", &native, &node, &metrics, false);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
}

/// Hash a mais/a menos conta como divergência; o live fica fora.
#[test]
fn bludv_compara_hash_por_tracker() {
    let native = batch(
        vec![bludv_item(HASH_A)],
        false,
        Some(live(&[], &[], &["bludv"], LiveAllState::Unknown)),
    );
    let node = batch(
        vec![bludv_item(HASH_B)],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    let metrics = SourceShadowMetrics::new();
    let comparison = record_comparison_opts("bludv", &native, &node, &metrics, false);
    assert_eq!(comparison.missing_count, 1);
    assert_eq!(comparison.extra_count, 1);
    assert!(
        comparison.missing.contains_key("bludv"),
        "a chave do conjunto é o tracker normalizado: {:?}",
        comparison.missing
    );
    assert_eq!(metrics.get(DIVERGENCE), 1);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
}

/// O `tracker` é o id quando o item não tem `indexer` (BLUDV): os dois lados
/// caem no mesmo balde "bludv".
#[test]
fn bludv_identidade_usa_o_tracker_quando_falta_indexer() {
    let native = batch(
        vec![bludv_item(HASH_A)],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    let node = batch(
        vec![bludv_item(HASH_A)],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    let comparison = compare_batches_opts(&native, &node, false);
    assert!(!comparison.diverged());
    assert!(comparison.missing.is_empty());
    assert!(comparison.extra.is_empty());
}

/// Fonte fora da seleção (`config.bludv.enabled=false` no Node): a referência
/// read-only devolve `eligible:false` e o par é pulado.
#[tokio::test]
async fn bludv_skipped_quando_fora_da_selecao() {
    let metrics = SourceShadowMetrics::new();
    let native = stub(
        Ok(batch(
            vec![bludv_item(HASH_A)],
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
        source: "bludv",
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

/// Par elegível com os mesmos hashes: compara e NÃO conta divergência.
#[tokio::test]
async fn bludv_par_elegivel_compara_sem_divergencia() {
    let metrics = SourceShadowMetrics::new();
    let state = live(&[], &[], &[], LiveAllState::Unknown);
    let native = stub(
        Ok(batch(vec![bludv_item(HASH_A)], false, Some(state.clone()))),
        0,
    );
    let node = stub_ref(
        Ok((batch(vec![bludv_item(HASH_A)], false, Some(state)), true)),
        0,
    );
    let pair = ShadowPair {
        source: "bludv",
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
