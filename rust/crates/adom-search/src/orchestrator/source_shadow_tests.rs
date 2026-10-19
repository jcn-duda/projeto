use std::sync::Arc;

use adom_sources::now_ms;

use super::*;
use crate::orchestrator::collect::Collector;
use crate::orchestrator::live_state::LiveAllState;

use super::test_support::{batch, item, job, live, stub, stub_ref};

fn pair(native: Arc<dyn Collector>, node: Arc<dyn ReferenceCollector>) -> ShadowPair {
    ShadowPair {
        source: "jackett",
        native,
        node,
    }
}

#[test]
fn iguais_nao_divergem_e_contam_compared() {
    let state = live(&[], &[], &[], LiveAllState::Ok);
    let native = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(state.clone()),
    );
    let node = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(state),
    );
    let comparison = compare_batches(&native, &node);
    assert!(!comparison.diverged());
    assert_eq!(comparison.missing_count, 0);
    assert_eq!(comparison.extra_count, 0);

    let metrics = SourceShadowMetrics::new();
    record_comparison("jackett", &native, &node, &metrics);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(ITEMS_MISSING), 0);
    assert_eq!(metrics.get(ITEMS_EXTRA), 0);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
}

#[test]
fn hash_extra_e_faltante_por_indexer() {
    let state = live(&[], &[], &[], LiveAllState::Ok);
    let native = batch(
        vec![
            item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            item("yts", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        ],
        false,
        Some(state.clone()),
    );
    let node = batch(
        vec![
            item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            item("yts", "cccccccccccccccccccccccccccccccccccccccc"),
        ],
        false,
        Some(state),
    );
    let comparison = compare_batches(&native, &node);
    assert_eq!(comparison.missing_count, 1, "CCCC só no Node");
    assert_eq!(comparison.extra_count, 1, "BBBB só no nativo");
    assert!(comparison.missing["yts"]
        .iter()
        .any(|hash| hash.starts_with("cccc")));
    assert!(comparison.extra["yts"]
        .iter()
        .any(|hash| hash.starts_with("bbbb")));

    let metrics = SourceShadowMetrics::new();
    record_comparison("jackett", &native, &node, &metrics);
    assert_eq!(metrics.get(ITEMS_MISSING), 1);
    assert_eq!(metrics.get(ITEMS_EXTRA), 1);
    assert_eq!(metrics.get(DIVERGENCE), 1);
}

#[test]
fn normaliza_hash_e_indexer() {
    let state = live(&[], &[], &[], LiveAllState::Ok);
    let native = batch(
        vec![item(" YTS ", "aaaabbbbaaaabbbbaaaabbbbaaaabbbbaaaabbbb")],
        false,
        Some(state.clone()),
    );
    let node = batch(
        vec![item("yts", "AAAABBBBAAAABBBBAAAABBBBAAAABBBBAAAABBBB")],
        false,
        Some(state),
    );
    assert!(!compare_batches(&native, &node).diverged());
}

#[test]
fn live_diferente_marca_live_divergence() {
    let native = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(live(&["bludv"], &[], &[], LiveAllState::Ok)),
    );
    let node = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(live(&["mico"], &[], &[], LiveAllState::Ok)),
    );
    let comparison = compare_batches(&native, &node);
    assert!(comparison.live_divergence);
    assert!(comparison.diverged());

    let metrics = SourceShadowMetrics::new();
    record_comparison("jackett", &native, &node, &metrics);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 1);
    assert_eq!(metrics.get(DIVERGENCE), 1);
}

#[test]
fn all_so_compara_quando_os_dois_tem_veredito() {
    let native = batch(vec![], false, Some(live(&[], &[], &[], LiveAllState::Ok)));
    // Node per-indexer deixa `all=Unknown`; isso NÃO é divergência.
    let node = batch(
        vec![],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    assert!(!compare_batches(&native, &node).live_divergence);

    // Com veredito nos dois lados, Ok × Error divergem.
    let node_error = batch(
        vec![],
        false,
        Some(live(&["yts"], &[], &[], LiveAllState::Error)),
    );
    assert!(
        compare_batches(&native, &node_error).live_divergence,
        "sets e all conhecidos divergem"
    );
}

#[tokio::test]
async fn timeout_nao_e_divergencia() {
    let metrics = SourceShadowMetrics::new();
    let state = live(&[], &[], &[], LiveAllState::Ok);
    let blocked = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(state.clone()),
    );
    let native = stub(Ok(blocked.clone()), 200);
    let node = stub_ref(Ok((blocked, true)), 0);
    run_pair(pair(native, node), job(now_ms() + 20), metrics.clone()).await;
    assert_eq!(metrics.get(TIMEOUT), 1);
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(ERROR), 0);
}

#[tokio::test]
async fn erro_nao_e_divergencia() {
    let metrics = SourceShadowMetrics::new();
    let state = live(&[], &[], &[], LiveAllState::Ok);
    let ok = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(state),
    );
    let native = stub(Err("cliente fora".into()), 0);
    let node = stub_ref(Ok((ok, true)), 0);
    run_pair(pair(native, node), job(now_ms() + 1_000), metrics.clone()).await;
    assert_eq!(metrics.get(ERROR), 1);
    assert_eq!(metrics.get(TIMEOUT), 0);
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
}

#[test]
fn f21_so_jackett_entra_na_sombra() {
    assert_eq!(shadow_sources("jackett", "jackett"), Vec::<&str>::new());
    assert_eq!(
        shadow_sources("jackett,BLUDV , jackett", "jackett"),
        Vec::<&str>::new(),
        "BLUDV não é F2.1"
    );
    assert_eq!(
        shadow_sources("prowlarr,torrentio,desconhecida", ""),
        Vec::<&str>::new(),
        "fora de F2.1 é ignorado, não roda"
    );
    assert_eq!(shadow_sources("JACKETT", ""), vec!["jackett"]);
    assert_eq!(shadow_sources("", "jackett"), Vec::<&str>::new());
}

#[test]
fn tokens_ignorados_aparecem_para_log() {
    assert_eq!(
        ignored_shadow_tokens("jackett,BLUDV,prowlarr,desconhecida", "torrentio"),
        vec![
            "BLUDV".to_string(),
            "prowlarr".to_string(),
            "desconhecida".to_string()
        ]
    );
}

/// Timeout de UM indexer chega como `Failed` nos dois lotes: a comparação
/// acontece normalmente e NÃO vira `source.shadow.timeout` (que é do par).
#[test]
fn falha_de_indexer_nao_vira_timeout_da_sombra() {
    let state = live(&["yts"], &[], &[], LiveAllState::Error);
    let native = batch(vec![], false, Some(state.clone()));
    let node = batch(vec![], false, Some(state));
    let metrics = SourceShadowMetrics::new();
    record_comparison("jackett", &native, &node, &metrics);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(TIMEOUT), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
}
