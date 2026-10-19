use super::*;
use crate::internal_types::CollectResponse;
use crate::orchestrator::config::OrchestratorConfig;
use serde_json::json;

fn meta_movie() -> SearchMeta {
    SearchMeta {
        imdb_id: "tt0133093".into(),
        name: "The Matrix".into(),
        names: vec!["The Matrix".into()],
        query: "The Matrix 1999".into(),
        year: json!(1999),
        ..SearchMeta::default()
    }
}

#[test]
fn plan_jobs_leva_type_stremio_nao_rotulo_do_grupo() {
    let config = OrchestratorConfig::default();
    let jobs = plan_jobs(
        &config,
        &meta_movie(),
        "movie",
        Some("e30"),
        1_700_000_000_000,
    );
    assert!(!jobs.is_empty());
    for job in &jobs {
        assert_eq!(
            job.kind, "movie",
            "kind do job é movie|series, não priority/global"
        );
        let body = serde_json::to_value(collect_request_from_job(job.clone())).unwrap();
        assert_eq!(body["type"], json!("movie"));
        assert_ne!(body["type"], json!("priority"));
        assert_ne!(body["type"], json!("global"));
        assert!(matches!(
            body["task_scope"].as_str(),
            Some("all") | Some("priority") | Some("nonpriority") | None
        ));
    }
}

#[test]
fn sweep_job_tambem_manda_movie_ou_series() {
    let config = OrchestratorConfig {
        sweep_enabled: true,
        ..Default::default()
    };
    let mut meta = meta_movie();
    meta.sweep_query = Some("Matrix".into());
    let job = sweep_job(&config, &meta, "series", None, 1_700_000_000_000).expect("sweep");
    assert_eq!(job.kind, "series");
    assert!(job.late_sweep, "passe tardio marca late_sweep");
    let body = serde_json::to_value(collect_request_from_job(job)).unwrap();
    assert_eq!(body["type"], json!("series"));
    assert_eq!(body["task_scope"], json!("all"));
}

#[test]
fn plan_jobs_nao_marca_late_sweep() {
    let config = OrchestratorConfig::default();
    let jobs = plan_jobs(&config, &meta_movie(), "movie", None, 1_700_000_000_000);
    assert!(jobs.iter().all(|j| !j.late_sweep));
}

/// `skip_sources` sai no corpo só quando há fonte migrada: sem ela o
/// contrato antigo (sem a chave) fica intacto para o Node.
#[test]
fn corpo_do_collect_carrega_skip_sources_so_quando_ha() {
    let mut request = CollectRequest {
        encoded: "e30".into(),
        query: "Filme".into(),
        media_type: "movie".into(),
        imdb: "tt0000001".into(),
        deadline_at: 1,
        task_scope: None,
        pt_query: None,
        season: None,
        episode: None,
        year: None,
        names: None,
        sweep_query: None,
        original_query: None,
        multi_work_query: None,
        skip_sources: Vec::new(),
    };
    let sem = serde_json::to_value(&request).expect("json");
    assert!(sem.get("skip_sources").is_none());
    request.skip_sources = vec!["jackett".into(), "mico".into()];
    let com = serde_json::to_value(&request).expect("json");
    assert_eq!(com["skip_sources"], json!(["jackett", "mico"]));
}

/// O `live.snapshot()` que a rota interna devolve chega inteiro: as quatro
/// chaves do estado vivo, com o agregado `/all`. Sem elas o Rust cairia na
/// regua antiga mesmo tendo o Node classificado falha por indexer.
#[test]
fn resposta_do_node_carrega_o_estado_vivo_por_indexer() {
    let wire = json!({
        "ok": true,
        "task_scope": "priority",
        "query": "Filme",
        "imdb_id": "tt0000001",
        "partial": true,
        "items": [],
        "live": {
            "failed": ["BLUDV"],
            "pending": ["mico"],
            "empty": ["hdr"],
            "all": "error"
        }
    });
    let response: CollectResponse = serde_json::from_value(wire).expect("contrato do fio");
    let state = response
        .live
        .as_ref()
        .map(LiveBatchState::from_wire)
        .expect("live");
    assert!(state.failed.contains("bludv"), "chave normalizada");
    assert!(state.pending.contains("mico"));
    assert!(state.suspect_indexers().contains("hdr"));
    assert_eq!(
        state.all,
        crate::orchestrator::live_state::LiveAllState::Error
    );
    assert!(state.has_any_failure());
}
