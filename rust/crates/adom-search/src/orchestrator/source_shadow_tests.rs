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
        compare_live: true,
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
fn sombra_aceita_jackett_prowlarr_torrentio_mico_e_bludv() {
    assert_eq!(shadow_sources("jackett", "jackett"), Vec::<&str>::new());
    assert_eq!(
        shadow_sources("jackett,BLUDV , jackett", "jackett"),
        vec!["bludv"],
        "BLUDV entrou na sombra (C3)"
    );
    assert_eq!(shadow_sources("prowlarr", ""), vec!["prowlarr"]);
    assert_eq!(
        shadow_sources("prowlarr", "prowlarr"),
        Vec::<&str>::new(),
        "fonte no corte nativo não roda sombra"
    );
    assert_eq!(
        shadow_sources("jackett,prowlarr", ""),
        vec!["jackett", "prowlarr"]
    );
    assert_eq!(
        shadow_sources("torrentio,bludv,mico,desconhecida", ""),
        vec!["torrentio", "bludv", "mico"],
        "BLUDV e Mico entram na sombra; token desconhecido sai"
    );
    assert_eq!(
        shadow_sources("torrentio", "torrentio"),
        Vec::<&str>::new(),
        "corte nativo do Torrentio não roda sombra"
    );
    assert_eq!(
        shadow_sources("mico", "mico"),
        Vec::<&str>::new(),
        "corte nativo do Mico não roda sombra"
    );
    assert_eq!(
        shadow_sources("bludv", "bludv"),
        Vec::<&str>::new(),
        "corte nativo do BLUDV não roda sombra"
    );
    assert_eq!(
        shadow_sources("jackett,prowlarr,torrentio,mico,bludv", ""),
        vec!["jackett", "prowlarr", "torrentio", "mico", "bludv"]
    );
    assert_eq!(shadow_sources("JACKETT", ""), vec!["jackett"]);
    assert_eq!(shadow_sources(" PROWLARR , prowlarr", ""), vec!["prowlarr"]);
    assert_eq!(shadow_sources(" TORRENTIO ", ""), vec!["torrentio"]);
    assert_eq!(shadow_sources(" MICO ", ""), vec!["mico"]);
    assert_eq!(shadow_sources(" BLUDV ", ""), vec!["bludv"]);
    assert_eq!(shadow_sources("", "jackett"), Vec::<&str>::new());
}

#[test]
fn tokens_ignorados_aparecem_para_log() {
    assert_eq!(
        ignored_shadow_tokens("jackett,BLUDV,torrentio,desconhecida", "prowlarr"),
        vec!["desconhecida".to_string()],
        "BLUDV é sombra; só token fora do recorte é ignorado"
    );
    // Já migrado no corte nativo também é ignorado (não é sombra).
    assert_eq!(
        ignored_shadow_tokens("prowlarr", "prowlarr"),
        vec!["prowlarr".to_string()]
    );
    assert_eq!(
        ignored_shadow_tokens("torrentio", "torrentio"),
        vec!["torrentio".to_string()]
    );
    assert_eq!(
        ignored_shadow_tokens("bludv", "bludv"),
        vec!["bludv".to_string()]
    );
}

/// Montagem dos coletores da sombra: Prowlarr, Torrentio, Mico e BLUDV entram
/// SEM override de `JACKETT_INDEXERS` (não têm indexers) e o recorte é
/// jackett/prowlarr/torrentio/mico/bludv.
#[test]
fn native_collector_monta_prowlarr_torrentio_mico_bludv_e_limita_o_recorte() {
    let prowlarr = native_collector("prowlarr").expect("ProwlarrCollector monta sem chave");
    assert!(
        prowlarr.indexers.is_none(),
        "Prowlarr não tem lista de JACKETT_INDEXERS"
    );
    let torrentio = native_collector("torrentio").expect("TorrentioCollector monta sem config");
    assert!(
        torrentio.indexers.is_none(),
        "Torrentio não tem lista de JACKETT_INDEXERS"
    );
    let mico = native_collector("mico").expect("MicoCollector monta sem config");
    assert!(
        mico.indexers.is_none(),
        "Mico consulta por IMDb, sem lista de JACKETT_INDEXERS"
    );
    let bludv = native_collector("bludv").expect("BludvCollector monta sem config");
    assert!(
        bludv.indexers.is_none(),
        "BLUDV consulta por título, sem lista de JACKETT_INDEXERS"
    );
    let jackett = native_collector("jackett").expect("JackettCollector monta");
    assert!(
        jackett.indexers.is_some(),
        "Jackett leva a lista do processo como fallback do ji"
    );
    assert!(
        native_collector("desconhecido").is_err(),
        "fonte fora do recorte não monta sombra"
    );
    assert!(!has_live_reference("prowlarr"));
    assert!(!has_live_reference("torrentio"));
    assert!(
        !has_live_reference("bludv"),
        "o Node não emite live do BLUDV"
    );
    assert!(has_live_reference("jackett"));
    assert!(has_live_reference("mico"), "o Node emite live para o Mico");
}

/// O Node não emite `live` para o Prowlarr: comparar o live nativo com o
/// snapshot vazio da referência daria divergência FALSA. O par do Prowlarr
/// entra com `compare_live:false` e só a identidade é comparada.
#[test]
fn prowlarr_nao_compara_live_sem_contrato_do_node() {
    let native = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(live(&["prowlarr"], &[], &[], LiveAllState::Unknown)),
    );
    let node = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    // Com a régua do Jackett (compare_live = true) o live divergiria…
    assert!(
        compare_batches(&native, &node).live_divergence,
        "o snapshot vazio do Node não atesta nada do Prowlarr"
    );
    // …mas o par do Prowlarr desliga essa comparação: mesmos hashes, sem
    // divergência de fonte.
    let comparison = compare_batches_opts(&native, &node, false);
    assert!(!comparison.live_divergence);
    assert!(!comparison.diverged());

    let metrics = SourceShadowMetrics::new();
    record_comparison_opts("prowlarr", &native, &node, &metrics, false);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
}

/// A sombra do Prowlarr compara a IDENTIDADE (`_indexer` = tracker) dos dois
/// lados: hash a mais/a menos continua contando como divergência.
#[test]
fn prowlarr_compara_hash_por_tracker() {
    let native = batch(
        vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        false,
        Some(live(&[], &["prowlarr"], &[], LiveAllState::Unknown)),
    );
    let node = batch(
        vec![item("yts", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
        false,
        Some(live(&[], &[], &[], LiveAllState::Unknown)),
    );
    let metrics = SourceShadowMetrics::new();
    let comparison = record_comparison_opts("prowlarr", &native, &node, &metrics, false);
    assert_eq!(comparison.missing_count, 1);
    assert_eq!(comparison.extra_count, 1);
    assert_eq!(metrics.get(DIVERGENCE), 1);
    assert_eq!(metrics.get(LIVE_DIVERGENCE), 0);
}

/// Fonte do Prowlarr fora dos `providers` efetivos: a referência read-only
/// devolve `eligible:false` e o par é pulado (sem compared/divergence).
#[tokio::test]
async fn prowlarr_skipped_quando_fora_da_selecao() {
    let metrics = SourceShadowMetrics::new();
    let native = stub(
        Ok(batch(
            vec![item("yts", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
            false,
            Some(live(&[], &["prowlarr"], &[], LiveAllState::Unknown)),
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
        source: "prowlarr",
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
