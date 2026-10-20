//! Testes do modo sombra do coletor Jackett (extraídos de
//! `jackett_collector_tests.rs` pela catraca de 400 linhas).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use super::*;
use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectJob, Collector};
use crate::orchestrator::live_state::LiveAllState;
use adom_sources::jackett::{JackettClient, JackettConfig};
use adom_sources::{now_ms, IndexerStatus, JackettRawItem, QueryOutcome};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use serde_json::json;

fn outcome(indexer: &str, status: IndexerStatus) -> QueryOutcome {
    outcome_with_items(indexer, status, Vec::new())
}

fn outcome_with_items(
    indexer: &str,
    status: IndexerStatus,
    items: Vec<JackettRawItem>,
) -> QueryOutcome {
    QueryOutcome {
        indexer: indexer.to_string(),
        items,
        ms: 1,
        from_cache: false,
        source_ok: matches!(status, IndexerStatus::Ok | IndexerStatus::Empty),
        source_error: None,
        status,
        record_status: true,
        primary: true,
    }
}

fn matrix_item() -> JackettRawItem {
    JackettRawItem {
        title: "The Matrix 1999 1080p".into(),
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
        providers: Vec::new(),
        jackett_indexers: Vec::new(),
        dubbed_only: false,
        mico_default: false,
    }
}

#[derive(Clone, Default)]
struct Hits(Arc<AtomicUsize>);

async fn start_offline() -> (String, Hits) {
    let hits = Hits::default();
    let app = Router::new()
        .route("/api/v2.0/indexers/{indexer}/results", get(offline))
        .with_state(hits.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), hits)
}

async fn offline(State(hits): State<Hits>, Path(_indexer): Path<String>) -> impl IntoResponse {
    hits.0.fetch_add(1, Ordering::SeqCst);
    StatusCode::INTERNAL_SERVER_ERROR
}

fn shadow_config(base: &str) -> JackettConfig {
    JackettConfig {
        url: base.to_string(),
        api_key: "test-key".into(),
        indexers: vec!["yts".into()],
        pt_br_indexers: Vec::new(),
        slow_indexers: Vec::new(),
        indexer_timeout_ms: 800,
        br_indexer_timeout_ms: 800,
        breaker_failures: 1,
        breaker_cooldown_ms: 60_000,
        ..JackettConfig::default()
    }
}

fn shadow_collector(client: JackettClient) -> JackettCollector {
    JackettCollector::new(client)
        .with_plan(vec!["yts".into()], Vec::new(), Vec::new(), Vec::new())
        .with_shadow(true)
}

#[tokio::test]
async fn sombra_ignora_breaker_aberto_do_principal_e_mantem_live() {
    let (base, hits) = start_offline().await;
    let client = JackettClient::new(shadow_config(&base)).expect("client");
    client.breaker().record("yts", false, now_ms());
    let cfg = client.config().clone();
    assert!(client.breaker().tripped("yts", &cfg, now_ms()));

    let batch = shadow_collector(client.clone())
        .collect(base_job())
        .await
        .expect("coleta");
    assert!(
        hits.0.load(Ordering::SeqCst) >= 1,
        "sombra consulta mesmo com o breaker do principal aberto"
    );
    let live = batch.live.expect("live para comparação");
    assert!(live.failed.contains("yts"), "falha entra no live da sombra");
    assert_eq!(live.all, LiveAllState::Error);
    // Continua com a única falha do principal: a sombra NÃO registrou outra.
    let snap = client.breaker().snapshot("yts", &cfg, now_ms());
    assert_eq!(snap.fail_streak, 1);
}

#[tokio::test]
async fn falha_da_sombra_nao_abre_breaker() {
    let (base, _hits) = start_offline().await;
    let client = JackettClient::new(shadow_config(&base)).expect("client");
    let batch = shadow_collector(client.clone())
        .collect(base_job())
        .await
        .expect("coleta");
    let live = batch.live.expect("live para comparação");
    assert!(live.failed.contains("yts"));
    let cfg = client.config().clone();
    assert!(!client.breaker().tripped("yts", &cfg, now_ms()));
    assert_eq!(
        client.breaker().snapshot("yts", &cfg, now_ms()).fail_streak,
        0,
        "record_status:false não grava no breaker"
    );
}

#[test]
fn shadow_ignora_sweep_ok_quando_principal_falhou() {
    let principal = outcome("yts", IndexerStatus::Failed);
    let mut sweep = outcome("yts", IndexerStatus::Ok);
    sweep.primary = false;
    sweep.record_status = false;
    let (shadow, _) = live_state_from_outcomes_shadow(&[principal, sweep], &base_job(), true);
    assert!(
        shadow.failed.contains("yts"),
        "sweep Ok não pode mascarar a falha principal"
    );
    assert_eq!(shadow.all, LiveAllState::Error);
}

#[test]
fn shadow_nao_inventa_falha_do_sweep_quando_principal_ok() {
    let principal = outcome_with_items("yts", IndexerStatus::Ok, vec![matrix_item()]);
    let mut sweep = outcome("yts", IndexerStatus::Failed);
    sweep.primary = false;
    sweep.record_status = false;
    let (shadow, _) = live_state_from_outcomes_shadow(&[principal, sweep], &base_job(), true);
    assert!(
        shadow.failed.is_empty(),
        "falha do sweep não pode pintar a principal"
    );
    assert_eq!(shadow.all, LiveAllState::Ok);
}

#[test]
fn live_exempt_vence_index_only_na_presenca_ao_vivo() {
    assert_eq!(
        default_live_exempt_indexers(),
        vec!["apachetorrent-cardigann"]
    );
    let apache = "apachetorrent-cardigann".to_string();
    let yts = "yts".to_string();
    let planned = plan_jackett_searches(
        &base_job(),
        &[apache.clone(), yts.clone()],
        &[],
        &[],
        std::slice::from_ref(&apache),
        std::slice::from_ref(&apache),
        false,
    );
    assert!(!planned.is_empty());
    assert!(
        planned.iter().any(|step| step.indexers.contains(&apache)),
        "card exempt precisa entrar na consulta ao vivo"
    );
    assert!(
        planned.iter().any(|step| step.indexers.contains(&yts)),
        "indexer comum continua"
    );
}

#[test]
fn title_precision_faz_trim_do_false() {
    assert!(!parse_title_precision_tail_cut(" false "));
    assert!(!parse_title_precision_tail_cut("false"));
    assert!(parse_title_precision_tail_cut(" true "));
    assert!(parse_title_precision_tail_cut(""));
}
