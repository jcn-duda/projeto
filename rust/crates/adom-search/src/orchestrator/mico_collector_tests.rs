//! Testes de identidade/args do coletor Mico (sem rede para os casos de erro).

use super::*;
use crate::orchestrator::collect::CollectJob;
use crate::orchestrator::sources_rust::sources_rust_csv_includes;
use adom_sources::{MicoConfig, MICO_ID};
use serde_json::json;

fn base_job() -> CollectJob {
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
        pt_query: Some("Matrix 1999".into()),
        sweep_query: Some("Matrix".into()),
        original_query: None,
        multi_work_query: None,
        priority: true,
        // Futuro: o coletor honra o deadline e devolveria `pending` no passado.
        deadline_at: adom_sources::now_ms() + 5_000,
        late_sweep: false,
        providers: Vec::new(),
        jackett_indexers: Vec::new(),
        dubbed_only: false,
        mico_default: true,
    }
}

fn disabled_collector() -> MicoCollector {
    let cfg = MicoConfig {
        enabled: false,
        ..Default::default()
    };
    MicoCollector::new(MicoClient::new(cfg).expect("client"))
}

#[test]
fn token_mico_no_csv() {
    assert!(sources_rust_csv_includes("mico", "mico"));
    assert!(sources_rust_csv_includes("jackett,mico", "mico"));
    assert!(!sources_rust_csv_includes("jackett", "mico"));
}

#[test]
fn mapa_preserva_hash_indexer_e_br() {
    let raw = raw_from_mico(MicoRawItem {
        title: "Matrix 1999".into(),
        info_hash: "abcd0123456789abcdef0123456789abcdef01".into(),
        magnet: "magnet:?xt=urn:btih:abcd0123456789abcdef0123456789abcdef01".into(),
        seeders: 1.0,
        size: Some(1_024.0),
        indexer: MICO_ID.into(),
        is_br: true,
    });
    assert_eq!(raw.indexer.as_deref(), Some("mico"));
    assert!(raw.is_br);
    assert_eq!(
        raw.info_hash.as_deref(),
        Some("abcd0123456789abcdef0123456789abcdef01")
    );
    assert_eq!(
        raw.size_bytes, None,
        "1 KB sentinela é limpo pela régua do caminho Node (known_size)"
    );
    let grande = raw_from_mico(MicoRawItem {
        title: "Matrix 1999".into(),
        info_hash: "abcd0123456789abcdef0123456789abcdef01".into(),
        magnet: "magnet:?xt=urn:btih:abcd0123456789abcdef0123456789abcdef01".into(),
        seeders: 1.0,
        size: Some(2.0 * 1024.0 * 1024.0 * 1024.0),
        indexer: MICO_ID.into(),
        is_br: false,
    });
    assert_eq!(grande.size_bytes, Some(2.0 * 1024.0 * 1024.0 * 1024.0));
}

#[test]
fn serie_sem_se_nao_monta_args() {
    let job = CollectJob {
        kind: "series".into(),
        season: None,
        episode: Some(1),
        ..base_job()
    };
    assert!(search_args_from_job(&job).is_none());
}

#[test]
fn filme_monta_args_por_imdb() {
    let args = search_args_from_job(&base_job()).expect("args");
    assert_eq!(args.media_type, MicoMediaType::Movie);
    assert_eq!(args.imdb_id, "tt0133093");
    assert_eq!(args.season, None);
    assert_eq!(args.episode, None);
    assert_eq!(args.year, Some(1999));
}

#[test]
fn year_aceita_string_suja() {
    let job = CollectJob {
        year: Some(json!("1999–")),
        ..base_job()
    };
    let args = search_args_from_job(&job).expect("args");
    assert_eq!(args.year, Some(1999));
}

#[tokio::test]
async fn nonpriority_e_late_sweep_nao_consultam() {
    let collector = disabled_collector();

    let nonpriority = CollectJob {
        scope: TaskScope::Nonpriority,
        priority: false,
        ..base_job()
    };
    let batch = collector.collect(nonpriority).await.expect("ok");
    assert!(batch.items.is_empty());
    assert!(batch.live.is_none(), "nenhuma consulta foi prometida");

    let late = CollectJob {
        late_sweep: true,
        ..base_job()
    };
    let batch = collector.collect(late).await.expect("ok");
    assert!(batch.items.is_empty());
    assert!(batch.live.is_none());
}

#[tokio::test]
async fn disabled_fail_open_vazio() {
    let collector = disabled_collector();
    let batch = collector.collect(base_job()).await.expect("ok");
    assert!(batch.items.is_empty());
    assert!(!batch.partial);
    let live = batch.live.as_ref().expect("live");
    assert!(live.failed.is_empty());
    assert!(live.empty.is_empty());
    assert!(live.pending.is_empty());
}

#[tokio::test]
async fn fora_da_selecao_nao_consulta() {
    let collector = disabled_collector();
    let job = CollectJob {
        jackett_indexers: vec!["yts".into()],
        mico_default: false,
        ..base_job()
    };
    assert!(!job.wants("mico"));
    let batch = collector.collect(job).await.expect("ok");
    assert!(batch.items.is_empty());
    assert!(
        batch.live.is_some(),
        "contrato vivo vazio, sem inventar falha"
    );
    let live = batch.live.as_ref().expect("live");
    assert!(live.failed.is_empty() && live.empty.is_empty() && live.pending.is_empty());
}
