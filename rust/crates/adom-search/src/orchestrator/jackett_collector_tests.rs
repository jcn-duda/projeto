use super::*;
use crate::orchestrator::collect::CollectJob;
use crate::orchestrator::live_state::LiveAllState;
use adom_sources::{IndexerStatus, JackettRawItem, QueryOutcome, ALL_QUERY_INDEXER};
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
        priority: false,
        deadline_at: 1_700_000_000_000,
        late_sweep: false,
    }
}

fn outcome(indexer: &str, status: IndexerStatus) -> QueryOutcome {
    outcome_with_items(indexer, status, Vec::new())
}

fn outcome_with_items(
    indexer: &str,
    status: IndexerStatus,
    items: Vec<JackettRawItem>,
) -> QueryOutcome {
    let source_ok = matches!(status, IndexerStatus::Ok | IndexerStatus::Empty);
    QueryOutcome {
        indexer: indexer.to_string(),
        items,
        ms: 1,
        from_cache: false,
        source_ok,
        source_error: match status {
            IndexerStatus::Failed => Some("HTTP 500".into()),
            IndexerStatus::Pending => Some("timeout".into()),
            _ => None,
        },
        status,
        record_status: true,
        primary: true,
    }
}

fn item(title: &str) -> JackettRawItem {
    JackettRawItem {
        title: title.to_string(),
        magnet: Some("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
        info_hash: Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()),
        seeders: Some(5.0),
        size: Some(1.0),
        published_at: None,
        tracker: Some("yts".into()),
        indexer: "yts".into(),
        download_url: None,
        is_br: false,
    }
}

fn live(outcomes: &[QueryOutcome]) -> (crate::orchestrator::live_state::LiveBatchState, bool) {
    live_state_from_outcomes(outcomes, &base_job(), true)
}

#[test]
fn inline_sweep_nao_ignora_breaker() {
    let job = CollectJob {
        scope: TaskScope::Nonpriority,
        ..base_job()
    };
    let planned = plan_jackett_searches(
        &job,
        &["yts".into(), "bludv".into()],
        &["bludv".into()],
        &["bludv".into()],
        &[],
        &[],
        false,
    );
    let sweeps: Vec<_> = planned
        .iter()
        .filter(|p| p.options.record_status == Some(false))
        .collect();
    assert!(
        !sweeps.is_empty(),
        "varredura inline deve existir quando sweep_query ≠ query"
    );
    for s in sweeps {
        assert!(!s.options.ignore_breaker, "inline NÃO usa ignore_breaker");
        assert!(!s.priority, "varredura é nos globais");
    }
    let mains: Vec<_> = planned
        .iter()
        .filter(|p| p.options.record_status.is_none())
        .collect();
    assert!(!mains.is_empty());
    for m in mains {
        assert!(!m.options.ignore_breaker);
    }
}

#[test]
fn late_sweep_usa_ignore_breaker() {
    let job = CollectJob {
        late_sweep: true,
        scope: TaskScope::All,
        ..base_job()
    };
    let planned = plan_jackett_searches(
        &job,
        &["yts".into(), "bludv".into(), "1337x".into()],
        &["bludv".into()],
        &["bludv".into()],
        &["1337x".into()],
        &[],
        false,
    );
    assert_eq!(planned.len(), 1);
    assert_eq!(planned[0].query, "Matrix");
    assert_eq!(planned[0].indexers, vec!["yts".to_string()]);
    assert!(planned[0].options.ignore_breaker);
    assert_eq!(planned[0].options.record_status, Some(false));
}

#[test]
fn priority_scope_so_br() {
    let job = CollectJob {
        scope: TaskScope::Priority,
        sweep_query: None,
        ..base_job()
    };
    let planned = plan_jackett_searches(
        &job,
        &["yts".into(), "bludv".into()],
        &["bludv".into()],
        &["bludv".into()],
        &[],
        &[],
        false,
    );
    assert!(!planned.is_empty());
    assert!(planned.iter().all(|p| p.priority));
    assert!(planned.iter().all(|p| p.indexers == ["bludv"]));
}

#[test]
fn index_only_sozinho_nao_consulta() {
    let job = base_job();
    let planned = plan_jackett_searches(
        &job,
        &["1337x".into()],
        &[],
        &[],
        &["1337x".into()],
        &[],
        false,
    );
    assert!(planned.is_empty());
}

#[test]
fn um_ok_e_um_falho_all_ok_com_falha_nomeada() {
    let outcomes = [
        outcome("YTS", IndexerStatus::Ok),
        outcome("offline", IndexerStatus::Failed),
    ];
    let (live, partial) = live(&outcomes);
    assert_eq!(live.all, LiveAllState::Ok);
    assert!(live.failed.contains("offline"), "chave normalizada");
    assert!(!live.failed.contains("yts"));
    assert!(!partial);
}

#[test]
fn vazio_saudavel_vira_empty_e_all_ok() {
    let (live, partial) = live(&[outcome("HDR", IndexerStatus::Empty)]);
    assert_eq!(live.all, LiveAllState::Ok, "vazio válido é resposta");
    assert!(live.empty.contains("hdr"));
    assert!(live.suspect_indexers().contains("hdr"));
    assert!(!live.has_any_failure(), "vazio não é falha provada");
    assert!(!partial);
}

#[test]
fn todos_falham_vira_all_error() {
    let outcomes = [
        outcome("bludv", IndexerStatus::Failed),
        outcome("mico", IndexerStatus::Failed),
    ];
    let (live, partial) = live(&outcomes);
    assert_eq!(live.all, LiveAllState::Error);
    assert_eq!(live.failed.len(), 2);
    assert!(!partial, "falha não é prazo");
}

#[test]
fn pendente_sem_ok_vira_all_pending_e_partial() {
    let outcomes = [
        outcome("bludv", IndexerStatus::Failed),
        outcome("yts", IndexerStatus::Pending),
    ];
    let (live, partial) = live(&outcomes);
    assert_eq!(live.all, LiveAllState::Pending);
    assert!(live.pending.contains("yts"));
    assert!(partial, "pending no prazo torna o lote parcial");
    assert!(live.all.failed(), "agregado pendente conta como falho");
}

#[test]
fn ok_desfaz_empty_e_failed_do_mesmo_indexer() {
    let outcomes = [
        outcome("yts", IndexerStatus::Empty),
        outcome("yts", IndexerStatus::Failed),
        outcome_with_items(
            "yts",
            IndexerStatus::Ok,
            vec![item("The Matrix 1999 1080p")],
        ),
    ];
    let (live, partial) = live(&outcomes);
    assert!(live.empty.is_empty(), "servir desfaz a suspeita");
    assert!(live.failed.is_empty(), "resposta válida limpa a falha");
    assert!(!partial);
    assert_eq!(live.all, LiveAllState::Ok);
}

#[test]
fn sem_indexers_all_unknown() {
    let (live, partial) = live(&[]);
    assert_eq!(live.all, LiveAllState::Unknown);
    assert!(live.failed.is_empty() && live.pending.is_empty() && live.empty.is_empty());
    assert!(!partial);
}

#[test]
fn agregado_all_nao_publica_nome_de_indexer() {
    let outcomes = [outcome(ALL_QUERY_INDEXER, IndexerStatus::Empty)];
    let (live, partial) = live(&outcomes);
    assert_eq!(live.all, LiveAllState::Ok);
    assert!(live.empty.is_empty(), "agregado não vira empty por indexer");
    assert!(!partial);
}

#[test]
fn timeout_individual_vira_failed_sem_partial() {
    let mut timed_out = outcome("yts", IndexerStatus::Failed);
    timed_out.source_error = Some("timeout".into());
    let (state, partial) = live(&[timed_out]);
    assert!(state.failed.contains("yts"));
    assert!(state.pending.is_empty(), "timeout não é pending");
    assert_eq!(state.all, LiveAllState::Error);
    assert!(!partial, "prazo individual não torna o lote parcial");
}

#[test]
fn record_status_false_nao_alimenta_live_nem_partial() {
    let mut failed = outcome("bludv", IndexerStatus::Failed);
    failed.record_status = false;
    let mut empty = outcome("hdr", IndexerStatus::Empty);
    empty.record_status = false;
    let mut pending = outcome("yts", IndexerStatus::Pending);
    pending.record_status = false;
    let (state, partial) = live(&[failed, empty, pending]);
    assert_eq!(state.all, LiveAllState::Unknown);
    assert!(state.failed.is_empty() && state.pending.is_empty() && state.empty.is_empty());
    assert!(!partial, "varredura secundária não pode marcar parcial");
}

#[test]
fn item_irrelevante_em_200_vira_empty_nao_ok() {
    let outcomes = [outcome_with_items(
        "yts",
        IndexerStatus::Ok,
        vec![item("Outra Obra 2024 1080p")],
    )];
    let (state, partial) = live(&outcomes);
    assert_eq!(
        state.all,
        LiveAllState::Ok,
        "200 saudável continua resposta"
    );
    assert!(
        state.empty.contains("yts"),
        "itens de outra obra não provam serviço"
    );
    assert!(state.suspect_indexers().contains("yts"));
    assert!(!state.has_any_failure(), "vazio suspeito não é falha");
    assert!(!partial);
}

#[test]
fn item_relevante_limpa_a_suspeita_de_vazio() {
    let outcomes = [
        outcome_with_items("yts", IndexerStatus::Empty, Vec::new()),
        outcome_with_items(
            "yts",
            IndexerStatus::Ok,
            vec![item("The Matrix 1999 1080p")],
        ),
    ];
    let (state, _) = live(&outcomes);
    assert!(state.empty.is_empty(), "item relevante desfaz o empty");
    assert_eq!(state.all, LiveAllState::Ok);
}

#[test]
fn shadow_planeja_ignore_breaker_e_sem_record_status() {
    let planned = plan_jackett_searches(
        &base_job(),
        &["yts".into(), "bludv".into()],
        &["bludv".into()],
        &["bludv".into()],
        &[],
        &[],
        true,
    );
    assert!(!planned.is_empty());
    for step in &planned {
        assert!(step.options.ignore_breaker, "sombra ignora breaker");
        assert_eq!(
            step.options.record_status,
            Some(false),
            "sombra não registra breaker/status"
        );
    }
}

#[test]
fn shadow_live_usa_outcome_record_status_false() {
    let mut item_ok = outcome_with_items(
        "yts",
        IndexerStatus::Ok,
        vec![item("The Matrix 1999 1080p")],
    );
    item_ok.record_status = false;
    // Caminho principal: outcome secundário não alimenta live.
    let (main, _) = live(&[item_ok.clone()]);
    assert_eq!(main.all, LiveAllState::Unknown);
    // Sombra: mesma consulta PRECISA aparecer na comparação.
    let (shadow, partial) = live_state_from_outcomes_shadow(&[item_ok], &base_job(), true);
    assert_eq!(shadow.all, LiveAllState::Ok);
    assert!(shadow.failed.is_empty() && shadow.empty.is_empty());
    assert!(!partial);
}

#[test]
fn indexer_em_branco_e_ignorado_e_chave_normalizada() {
    let outcomes = [
        outcome("   ", IndexerStatus::Failed),
        outcome(" YTS ", IndexerStatus::Empty),
    ];
    let (state, _) = live(&outcomes);
    assert!(state.failed.is_empty(), "id vazio não vira indexer");
    assert!(state.empty.contains("yts"), "chave trim+lowercase");
}
