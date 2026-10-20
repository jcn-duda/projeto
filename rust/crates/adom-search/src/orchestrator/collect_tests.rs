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
        &RequestSelection::default(),
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
    let job = sweep_job(
        &config,
        &meta,
        "series",
        None,
        1_700_000_000_000,
        &RequestSelection::default(),
    )
    .expect("sweep");
    assert_eq!(job.kind, "series");
    assert!(job.late_sweep, "passe tardio marca late_sweep");
    let body = serde_json::to_value(collect_request_from_job(job)).unwrap();
    assert_eq!(body["type"], json!("series"));
    assert_eq!(body["task_scope"], json!("all"));
}

#[test]
fn plan_jobs_nao_marca_late_sweep() {
    let config = OrchestratorConfig::default();
    let jobs = plan_jobs(
        &config,
        &meta_movie(),
        "movie",
        None,
        1_700_000_000_000,
        &RequestSelection::default(),
    );
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
        read_only: false,
        shadow_source: None,
        indexers: None,
    };
    let sem = serde_json::to_value(&request).expect("json");
    assert!(sem.get("skip_sources").is_none());
    request.skip_sources = vec!["jackett".into(), "mico".into()];
    let com = serde_json::to_value(&request).expect("json");
    assert_eq!(com["skip_sources"], json!(["jackett", "mico"]));
    // `read_only` só viaja quando LIGADO (caminho de resposta fica intacto).
    assert!(sem.get("read_only").is_none());
    request.read_only = true;
    let ro = serde_json::to_value(&request).expect("json");
    assert_eq!(ro["read_only"], json!(true));
    assert!(ro.get("shadow_source").is_none());
    request.shadow_source = Some("jackett".into());
    let ro = serde_json::to_value(&request).expect("json");
    assert_eq!(ro["shadow_source"], json!("jackett"));
    assert!(ro.get("indexers").is_none());
    request.indexers = Some(vec!["yts".into(), "bludv".into()]);
    let ro = serde_json::to_value(&request).expect("json");
    assert_eq!(ro["indexers"], json!(["yts", "bludv"]));
}

/// `eligible` ausente (Node antigo) vale `true`; `false` atravessa o contrato.
#[test]
fn elegibilidade_do_fio_tem_default_true() {
    let wire = json!({
        "ok": true,
        "task_scope": "all",
        "query": "Filme",
        "imdb_id": "tt0000001",
        "partial": false,
        "items": [],
        "breaker": {}
    });
    let velho: CollectResponse = serde_json::from_value(wire).expect("contrato antigo");
    assert!(velho.eligible);
    let wire = json!({
        "ok": true,
        "task_scope": "all",
        "query": "Filme",
        "imdb_id": "tt0000001",
        "partial": false,
        "items": [],
        "breaker": {},
        "eligible": false
    });
    let novo: CollectResponse = serde_json::from_value(wire).expect("contrato novo");
    assert!(!novo.eligible);
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

// ═══════════════════════════════════════════════════════════════════════════════
// C0b — seleção da request no CollectJob (matriz providers×fonte)
// ═══════════════════════════════════════════════════════════════════════════════

/// Job com a seleção pedida; o resto vem do plano padrão (sem rede).
fn job_with(providers: &[&str], ji: &[&str], mico_default: bool) -> CollectJob {
    let config = OrchestratorConfig::default();
    let mut job = plan_jobs(
        &config,
        &meta_movie(),
        "movie",
        None,
        1_700_000_000_000,
        &RequestSelection::default(),
    )
    .remove(0);
    job.providers = providers.iter().map(|p| (*p).to_string()).collect();
    job.jackett_indexers = ji.iter().map(|i| (*i).to_string()).collect();
    job.mico_default = mico_default;
    job
}

/// (providers, ji, MICO_DEFAULT, [jackett, prowlarr, torrentio, mico, bludv]).
type ProviderCase = (
    &'static [&'static str],
    &'static [&'static str],
    bool,
    [bool; 5],
);

#[test]
fn matriz_providers_por_fonte_espelha_o_node() {
    let cases: &[ProviderCase] = &[
        // Sem `providers` na request: default do processo, nenhuma poda.
        (&[], &[], false, [true, true, true, false, true]),
        (&[], &[], true, [true, true, true, true, true]),
        // Jackett: `p` vence; torrentio fora; Mico depende do `ji`.
        (&["jackett"], &[], true, [true, false, false, true, true]),
        (
            &["jackett"],
            &["yts"],
            true,
            [true, false, false, false, true],
        ),
        (
            &["jackett"],
            &["yts", "mico"],
            false,
            [true, false, false, true, true],
        ),
        // Prowlarr não liga o `jackettMode`: o card Mico não roda.
        (
            &["prowlarr"],
            &["mico"],
            true,
            [false, true, false, false, true],
        ),
        // Torrentio é token de `providers` (kill-switch é do cliente).
        (
            &["torrentio"],
            &[],
            false,
            [false, false, true, false, true],
        ),
        // `both`: Jackett, Prowlarr e Torrentio juntos.
        (&["both"], &[], true, [true, true, true, true, true]),
        // Demo é o ramo isolado: nenhuma fonte real.
        (
            &["demo"],
            &["mico"],
            true,
            [false, false, false, false, false],
        ),
        (
            &["demo", "jackett"],
            &[],
            true,
            [false, false, false, false, false],
        ),
    ];
    for (providers, ji, mico_default, expected) in cases {
        let job = job_with(providers, ji, *mico_default);
        let got = [
            job.wants("jackett"),
            job.wants("prowlarr"),
            job.wants("torrentio"),
            job.wants("mico"),
            job.wants("bludv"),
        ];
        assert_eq!(
            got, *expected,
            "providers={providers:?} ji={ji:?} mico_default={mico_default}"
        );
        assert!(!job.wants("desconhecida"), "fonte fora do contrato");
    }
}

#[test]
fn plan_jobs_carrega_providers_ji_e_dubbed_da_request() {
    let config = OrchestratorConfig {
        pt_br_indexers: vec!["br".into()],
        ..Default::default()
    };
    let mut meta = meta_movie();
    meta.sweep_query = None;
    let selection = RequestSelection {
        providers: vec!["both".into()],
        jackett_indexers: vec!["yts".into(), "br".into(), "mico".into()],
        dubbed_only: true,
        mico_default: false,
    };
    let jobs = plan_jobs(
        &config,
        &meta,
        "movie",
        Some("e30"),
        1_700_000_000_000,
        &selection,
    );
    assert_eq!(jobs.len(), 2, "BR prioritário + globais");
    for job in &jobs {
        assert_eq!(job.providers, selection.providers);
        assert_eq!(job.jackett_indexers, selection.jackett_indexers);
        assert!(job.dubbed_only, "dubbedOnly viaja no job");
        assert!(job.jackett_mode());
        assert_eq!(
            job.jackett_indexers_for_plan(),
            vec!["yts".to_string(), "br".to_string()],
            "card virtual não entra no plano Torznab"
        );
    }
    assert!(jobs
        .iter()
        .any(|job| job.priority && job.scope == TaskScope::Priority));
    assert!(jobs
        .iter()
        .any(|job| !job.priority && job.scope == TaskScope::Nonpriority));
}

#[test]
fn plan_jobs_sem_ji_usa_default_do_operador() {
    let config = OrchestratorConfig {
        selected_indexers: vec!["yts".into()],
        ..Default::default()
    };
    let selection = RequestSelection {
        providers: vec!["jackett".into()],
        ..RequestSelection::default()
    };
    let jobs = plan_jobs(
        &config,
        &meta_movie(),
        "movie",
        None,
        1_700_000_000_000,
        &selection,
    );
    assert_eq!(jobs.len(), 1, "default não ganha recorte novo");
    assert_eq!(jobs[0].jackett_indexers, vec!["yts".to_string()]);
    assert!(jobs[0].wants("jackett"));
}

#[test]
fn plan_jobs_filtra_card_mico_do_plano_jackett() {
    let config = OrchestratorConfig::default();
    let selection = RequestSelection {
        providers: vec!["jackett".into()],
        jackett_indexers: vec!["mico".into()],
        ..RequestSelection::default()
    };
    let jobs = plan_jobs(
        &config,
        &meta_movie(),
        "movie",
        None,
        1_700_000_000_000,
        &selection,
    );
    assert_eq!(jobs.len(), 1, "só o card: nenhuma consulta Jackett");
    assert_eq!(jobs[0].jackett_indexers, vec!["mico".to_string()]);
    assert!(jobs[0].jackett_indexers_for_plan().is_empty());
    assert!(jobs[0].wants("mico"), "o coletor do Mico continua querendo");
}

#[test]
fn sweep_job_carrega_a_selecao_da_request() {
    let config = OrchestratorConfig {
        sweep_enabled: true,
        ..Default::default()
    };
    let mut meta = meta_movie();
    meta.sweep_query = Some("Matrix".into());
    let selection = RequestSelection {
        providers: vec!["both".into()],
        jackett_indexers: vec!["yts".into()],
        dubbed_only: true,
        mico_default: true,
    };
    let job =
        sweep_job(&config, &meta, "movie", None, 1_700_000_000_000, &selection).expect("sweep");
    assert_eq!(job.providers, selection.providers);
    assert_eq!(job.jackett_indexers, vec!["yts".to_string()]);
    assert!(job.dubbed_only);
    assert!(job.mico_default);
    assert!(job.late_sweep);
}
