use super::*;
use crate::orchestrator::collect::CollectJob;
use crate::orchestrator::live_state::LiveAllState;
use adom_sources::ProwlarrConfig;
use serde_json::json;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

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

/// O `_indexer`/`_tracker` do Node vêm do `tracker`; NUNCA de "prowlarr".
#[test]
fn mapa_usa_o_tracker_como_identidade_e_preserva_campos() {
    let raw = raw_from_prowlarr(ProwlarrRawItem {
        title: "The Matrix 1999 1080p".into(),
        magnet: Some("magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=x".into()),
        info_hash: Some("ABCDEF0123456789ABCDEF0123456789ABCDEF01".into()),
        seeders: Some(10.0),
        size: Some(1_000.0),
        tracker: Some(" Nyaa ".into()),
    });
    assert_eq!(raw.indexer.as_deref(), Some("Nyaa"));
    assert_eq!(raw.tracker.as_deref(), Some("Nyaa"));
    assert_eq!(raw.sources, vec!["tracker:Nyaa".to_string()]);
    assert_eq!(
        raw.hash(),
        "abcdef0123456789abcdef0123456789abcdef01",
        "hash do infoHash preservado"
    );
    assert_eq!(raw.title_text(), "The Matrix 1999 1080p");
    assert_eq!(raw.seeders, Some(10.0));
    assert_eq!(raw.size_bytes, Some(1_000.0));
    assert!(!raw.is_br, "Prowlarr não marca isBr; o build decide");
    assert_ne!(raw.indexer.as_deref(), Some("prowlarr"));
}

/// Sem `tracker` o Node deixa `_indexer` vazio (sem cota/chip de fonte);
/// o item continua com título/seeders/tamanho.
#[test]
fn mapa_sem_tracker_nao_inventa_indexer() {
    let raw = raw_from_prowlarr(ProwlarrRawItem {
        title: "Sem indexer".into(),
        magnet: None,
        info_hash: Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into()),
        seeders: Some(3.0),
        size: Some(2_000.0),
        tracker: Some("   ".into()),
    });
    assert_eq!(raw.indexer, None);
    assert_eq!(raw.tracker, None);
    assert!(raw.sources.is_empty());
    assert_eq!(raw.seeders, Some(3.0));
    assert_eq!(raw.size_bytes, Some(2_000.0));
}

/// `indexerId` numérico também vira identidade (é o que o `||` do TS faz).
#[test]
fn mapa_aceita_tracker_numerico() {
    let raw = raw_from_prowlarr(ProwlarrRawItem {
        title: "x".into(),
        magnet: None,
        info_hash: None,
        seeders: None,
        size: None,
        tracker: Some("9".into()),
    });
    assert_eq!(raw.indexer.as_deref(), Some("9"));
    assert_eq!(raw.sources, vec!["tracker:9".to_string()]);
}

#[tokio::test]
async fn priority_e_late_sweep_nao_consultam_e_nao_inventam_falha() {
    // Sem chave → a consulta nem tentaria; o early-return evita até o warn.
    let client = ProwlarrClient::new(ProwlarrConfig::default()).expect("client");
    let collector = ProwlarrCollector::new(client);

    let priority = CollectJob {
        scope: TaskScope::Priority,
        priority: true,
        ..base_job()
    };
    let batch = collector.collect(priority).await.expect("ok");
    assert!(batch.items.is_empty());
    let live = batch.live.expect("live");
    assert!(live.failed.is_empty() && live.empty.is_empty() && live.pending.is_empty());
    assert_eq!(live.all, LiveAllState::Unknown);

    let late = CollectJob {
        late_sweep: true,
        ..base_job()
    };
    let batch = collector.collect(late).await.expect("ok");
    assert!(batch.items.is_empty());
    let live = batch.live.expect("live");
    assert!(!live.has_any_failure(), "late_sweep não é consulta");
}

#[tokio::test]
async fn fora_dos_providers_nao_consulta() {
    let client = ProwlarrClient::new(ProwlarrConfig::default()).expect("client");
    let collector = ProwlarrCollector::new(client);
    let job = CollectJob {
        providers: vec!["jackett".into()],
        ..base_job()
    };
    let batch = collector.collect(job).await.expect("ok");
    assert!(batch.items.is_empty());
    let live = batch.live.expect("live");
    assert!(!live.has_any_failure());
    assert_eq!(live.all, LiveAllState::Unknown);
}

#[tokio::test]
async fn all_sem_chave_fail_open_vazio_e_sem_falha_viva() {
    let client = ProwlarrClient::new(ProwlarrConfig::default()).expect("client");
    let collector = ProwlarrCollector::new(client);
    let batch = collector.collect(base_job()).await.expect("ok");
    assert!(batch.items.is_empty());
    assert!(!batch.partial);
    let live = batch.live.expect("live");
    assert!(
        !live.has_any_failure(),
        "sem chave é configuração, não consulta falha"
    );
    assert_eq!(live.all, LiveAllState::Unknown);
    assert!(!live.pending.contains(PROWLARR_LIVE_KEY));
}

#[test]
fn live_falha_e_vazio_sao_por_fonte_e_nunca_pending() {
    let failed = live_failed();
    assert_eq!(
        failed.failed,
        BTreeSet::from([PROWLARR_LIVE_KEY.to_string()])
    );
    assert!(failed.pending.is_empty());
    assert_eq!(failed.all, LiveAllState::Unknown);

    let empty = live_empty();
    assert!(empty.failed.is_empty());
    assert_eq!(empty.empty, BTreeSet::from([PROWLARR_LIVE_KEY.to_string()]));
    assert_eq!(empty.all, LiveAllState::Unknown);
    assert!(empty.needs_fallback(), "vazio suspeito pede o banco");
    assert!(
        !empty.has_any_failure(),
        "vazio suspeito não é falha provada"
    );
}

// ── Matriz do live com servidor falso ──────────────────────────────────

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Mode {
    #[default]
    Ok,
    Empty,
    Irrelevant,
    Http429,
    Http500,
    InvalidJson,
    Hang,
}

#[derive(Clone)]
struct FakeState {
    mode: Mode,
    hits: Arc<AtomicUsize>,
}

async fn start(mode: Mode) -> (String, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let state = FakeState {
        mode,
        hits: hits.clone(),
    };
    let app = Router::new()
        .route("/api/v1/search", get(search))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{addr}"), hits)
}

async fn search(State(state): State<FakeState>) -> Response {
    state.hits.fetch_add(1, Ordering::SeqCst);
    match state.mode {
        Mode::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            StatusCode::OK.into_response()
        }
        Mode::Http429 => StatusCode::TOO_MANY_REQUESTS.into_response(),
        Mode::Http500 => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Mode::InvalidJson => (StatusCode::OK, axum::Json(json!({ "oops": true }))).into_response(),
        Mode::Empty => (StatusCode::OK, axum::Json(json!([]))).into_response(),
        Mode::Irrelevant => (
            StatusCode::OK,
            axum::Json(json!([raw(
                "Outro Filme 2001 1080p",
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            )])),
        )
            .into_response(),
        Mode::Ok => (
            StatusCode::OK,
            axum::Json(json!([raw(
                "The Matrix 1999 1080p",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            )])),
        )
            .into_response(),
    }
}

fn raw(title: &str, hash: &str) -> serde_json::Value {
    json!({
        "title": title,
        "magnetUrl": format!("magnet:?xt=urn:btih:{hash}"),
        "infoHash": hash,
        "seeders": 8,
        "size": 4096,
        "indexer": "YTS",
    })
}

fn config(base: &str, timeout_ms: u64) -> ProwlarrConfig {
    ProwlarrConfig {
        url: base.to_string(),
        api_key: "test-key".into(),
        timeout_ms,
        ..ProwlarrConfig::default()
    }
}

async fn collect_at(base: &str, timeout_ms: u64) -> CollectBatch {
    let client = ProwlarrClient::new(config(base, timeout_ms)).expect("client");
    ProwlarrCollector::new(client)
        .collect(base_job())
        .await
        .expect("coleta")
}

fn assert_no_pending_and_unknown_all(live: &LiveBatchState) {
    assert!(live.pending.is_empty(), "nunca inventa pending");
    assert_eq!(
        live.all,
        LiveAllState::Unknown,
        "all é só do ramo /all do Jackett"
    );
}

fn assert_failed(batch: &CollectBatch) {
    let live = batch.live.as_ref().expect("live");
    assert_eq!(live.failed, BTreeSet::from([PROWLARR_LIVE_KEY.to_string()]));
    assert!(live.empty.is_empty());
    assert_no_pending_and_unknown_all(live);
}

#[tokio::test]
async fn live_ok_quando_a_resposta_tem_item_relevante() {
    let (base, hits) = start(Mode::Ok).await;
    let batch = collect_at(&base, 1_500).await;
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(batch.items.len(), 1);
    let item = &batch.items[0];
    assert_eq!(item.indexer.as_deref(), Some("YTS"));
    assert_eq!(item.tracker.as_deref(), Some("YTS"));
    let live = batch.live.as_ref().expect("live");
    assert!(live.failed.is_empty() && live.empty.is_empty());
    assert_no_pending_and_unknown_all(live);
    assert!(!live.has_any_failure());
}

#[tokio::test]
async fn live_empty_quando_a_resposta_e_vazia() {
    let (base, _hits) = start(Mode::Empty).await;
    let batch = collect_at(&base, 1_500).await;
    assert!(batch.items.is_empty());
    let live = batch.live.as_ref().expect("live");
    assert!(live.failed.is_empty());
    assert_eq!(live.empty, BTreeSet::from([PROWLARR_LIVE_KEY.to_string()]));
    assert_no_pending_and_unknown_all(live);
}

/// 200 com item de OUTRA obra é vazio suspeito (`relevant: 0`), mas o item
/// continua no lote — quem filtra é o build, como no Node.
#[tokio::test]
async fn live_empty_quando_nada_e_relevante() {
    let (base, _hits) = start(Mode::Irrelevant).await;
    let batch = collect_at(&base, 1_500).await;
    assert_eq!(batch.items.len(), 1);
    let live = batch.live.as_ref().expect("live");
    assert_eq!(live.empty, BTreeSet::from([PROWLARR_LIVE_KEY.to_string()]));
    assert_no_pending_and_unknown_all(live);
}

#[tokio::test]
async fn live_failed_em_http_429() {
    let (base, hits) = start(Mode::Http429).await;
    let batch = collect_at(&base, 1_500).await;
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_failed(&batch);
}

#[tokio::test]
async fn live_failed_em_http_5xx() {
    let (base, _hits) = start(Mode::Http500).await;
    assert_failed(&collect_at(&base, 1_500).await);
}

#[tokio::test]
async fn live_failed_em_json_invalido() {
    let (base, _hits) = start(Mode::InvalidJson).await;
    assert_failed(&collect_at(&base, 1_500).await);
}

#[tokio::test]
async fn live_failed_em_timeout() {
    let (base, _hits) = start(Mode::Hang).await;
    assert_failed(&collect_at(&base, 80).await);
}

#[tokio::test]
async fn live_failed_em_falha_de_rede() {
    // Porta efêmera aberta e fechada em seguida: conexão recusada.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    drop(listener);
    assert_failed(&collect_at(&format!("http://{addr}"), 1_500).await);
}

/// Base barrada pela guarda SSRF é configuração inválida, não consulta
/// falha: o Node também não registra nada (o cliente devolve `[]`).
#[tokio::test]
async fn url_barrada_nao_vira_falha_viva() {
    let client = ProwlarrClient::new(ProwlarrConfig {
        url: "file:///etc/passwd".into(),
        api_key: "k".into(),
        ..ProwlarrConfig::default()
    })
    .expect("client");
    let batch = ProwlarrCollector::new(client)
        .collect(base_job())
        .await
        .expect("coleta");
    assert!(batch.items.is_empty());
    let live = batch.live.as_ref().expect("live");
    assert!(!live.has_any_failure());
    assert_no_pending_and_unknown_all(live);
}
