//! Matriz do eixo VIVO do coletor BLUDV (ok/empty/failed, `all=Unknown`, sem
//! `pending`), `dubbedOnly` e `raw:v1` (vivo grava/lê; sombra não toca).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_sources::{BludvClient, BludvConfig, MemoryRawStore, RawStore};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::json;

use super::*;

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Clone)]
struct Fake {
    calls: Arc<Mutex<Vec<String>>>,
    mode: Arc<Mutex<Mode>>,
    base: Arc<Mutex<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Mode {
    #[default]
    Ok,
    Http500,
    Hang,
    NoLinks,
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    s: Option<String>,
}

async fn start() -> (Fake, String) {
    let fake = Fake {
        calls: Arc::new(Mutex::new(Vec::new())),
        mode: Arc::new(Mutex::new(Mode::Ok)),
        base: Arc::new(Mutex::new(String::new())),
    };
    let app = Router::new()
        .route("/", get(search))
        .route("/filme/{slug}", get(post))
        .route("/systemads/{id}", get(protector))
        .route("/videosad/{id}", get(protector))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let base = format!("http://{addr}");
    *fake.base.lock().expect("base") = base.clone();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (fake, base)
}

impl Fake {
    fn set_mode(&self, mode: Mode) {
        *self.mode.lock().expect("mode") = mode;
    }

    fn base(&self) -> String {
        self.base.lock().expect("base").clone()
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls").clone()
    }
}

async fn search(State(fake): State<Fake>, Query(q): Query<SearchQuery>) -> Response {
    fake.calls
        .lock()
        .expect("calls")
        .push(format!("/?s={}", q.s.as_deref().unwrap_or("")));
    // Copia antes do `match`: o guard não pode atravessar o `.await` do Hang
    // (o futuro deixaria de ser `Send` e o Handler do axum não compila).
    let mode = *fake.mode.lock().expect("mode");
    match mode {
        Mode::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            StatusCode::OK.into_response()
        }
        Mode::Http500 => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Mode::Ok | Mode::NoLinks => Html(format!(
            r#"<div class="post"><div class="title"><a href="{}/filme/x">Matrix 1999</a></div></div>"#,
            fake.base()
        ))
        .into_response(),
    }
}

async fn post(State(fake): State<Fake>, Path(_slug): Path<String>) -> Response {
    fake.calls.lock().expect("calls").push("/filme/x".into());
    let base = fake.base();
    let mode = *fake.mode.lock().expect("mode");
    match mode {
        Mode::NoLinks => Html("<p>sem botões</p>".to_string()).into_response(),
        _ => Html(format!(
            r#"
            VERSÃO MKV DUAL ÁUDIO
            WEB-DL 1080p (3.39 GB - MKV)
            <a href="{base}/systemads/a">DL</a>
            VERSÃO MP4 LEGENDADO
            WEB-DL 720p (1.2 GB - MP4)
            <a href="{base}/videosad/b">DL</a>
            "#
        ))
        .into_response(),
    }
}

async fn protector(State(fake): State<Fake>, Path(id): Path<String>) -> Response {
    fake.calls
        .lock()
        .expect("calls")
        .push(format!("/protector/{id}"));
    let hash = if id == "b" { HASH_B } else { HASH };
    Html(format!(
        r#"<a href="magnet:?xt=urn:btih:{hash}&amp;dn=x">x</a>"#
    ))
    .into_response()
}

#[derive(Default)]
struct RecordingStore {
    inner: MemoryRawStore,
    gets: AtomicUsize,
    sets: AtomicUsize,
}

impl RawStore for RecordingStore {
    fn get(&self, key: &str, now_ms: i64) -> Option<serde_json::Value> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        self.inner.get(key, now_ms)
    }

    fn set(&self, key: &str, value: &serde_json::Value, ttl_seconds: u64, now_ms: i64) {
        self.sets.fetch_add(1, Ordering::SeqCst);
        self.inner.set(key, value, ttl_seconds, now_ms);
    }
}

fn config(base: &str) -> BludvConfig {
    BludvConfig {
        enabled: true,
        base_url: base.trim_end_matches('/').to_string(),
        timeout_ms: 500,
        allow_private_url: true,
        ..BludvConfig::default()
    }
}

fn collector(base: &str, store: Option<Arc<RecordingStore>>, shadow: bool) -> BludvCollector {
    let mut client = BludvClient::new(config(base)).expect("client");
    if let Some(store) = store {
        client = client.with_raw_store(store);
    }
    BludvCollector::new(client).with_shadow(shadow)
}

fn job(names: &[&str], dubbed_only: bool) -> CollectJob {
    CollectJob {
        encoded: "e30".into(),
        scope: TaskScope::All,
        kind: "movie".into(),
        imdb_id: "tt0133093".into(),
        season: None,
        episode: None,
        year: Some(json!(1999)),
        names: names.iter().map(|name| (*name).to_string()).collect(),
        query: "Matrix 1999".into(),
        pt_query: Some("Matrix 1999".into()),
        sweep_query: None,
        original_query: None,
        multi_work_query: None,
        priority: true,
        deadline_at: adom_sources::now_ms() + 2_000,
        late_sweep: false,
        providers: Vec::new(),
        jackett_indexers: Vec::new(),
        dubbed_only,
        mico_default: false,
    }
}

async fn collect(base: &str, shadow: bool, job: CollectJob) -> CollectBatch {
    collector(base, None, shadow)
        .collect(job)
        .await
        .expect("ok")
}

fn assert_live_contract(batch: &CollectBatch) {
    let live = batch.live.as_ref().expect("live do nativo");
    assert!(live.pending.is_empty(), "pending nunca é inventado");
    assert_eq!(
        live.all,
        crate::orchestrator::live_state::LiveAllState::Unknown
    );
}

#[tokio::test]
async fn live_ok_com_itens() {
    let (_fake, base) = start().await;
    let batch = collect(&base, false, job(&["Matrix"], false)).await;
    assert_eq!(batch.items.len(), 2);
    assert_live_contract(&batch);
    let live = batch.live.expect("live");
    assert!(live.failed.is_empty());
    assert!(live.empty.is_empty());
    assert_eq!(batch.items[0].tracker.as_deref(), Some("BLUDV"));
    assert_eq!(batch.items[0].indexer, None);
}

#[tokio::test]
async fn live_empty_quando_nenhum_item_relevante() {
    let (_fake, base) = start().await;
    let batch = collect(&base, false, job(&["Outra Obra"], false)).await;
    assert_eq!(batch.items.len(), 2, "resposta válida ainda entrega o lote");
    assert_live_contract(&batch);
    let live = batch.live.expect("live");
    assert!(live.empty.contains(BLUDV_LIVE_KEY));
    assert!(live.failed.is_empty());
}

#[tokio::test]
async fn live_empty_quando_site_responde_sem_botoes() {
    let (fake, base) = start().await;
    fake.set_mode(Mode::NoLinks);
    let batch = collect(&base, false, job(&["Matrix"], false)).await;
    assert!(batch.items.is_empty());
    assert_live_contract(&batch);
    assert!(batch.live.expect("live").empty.contains(BLUDV_LIVE_KEY));
}

#[tokio::test]
async fn live_failed_em_http_500() {
    let (fake, base) = start().await;
    fake.set_mode(Mode::Http500);
    let batch = collect(&base, false, job(&["Matrix"], false)).await;
    assert!(batch.items.is_empty());
    assert_live_contract(&batch);
    let live = batch.live.expect("live");
    assert!(live.failed.contains(BLUDV_LIVE_KEY));
    assert!(live.empty.is_empty());
}

#[tokio::test]
async fn live_failed_em_timeout() {
    let (fake, base) = start().await;
    fake.set_mode(Mode::Hang);
    let mut j = job(&["Matrix"], false);
    j.deadline_at = adom_sources::now_ms() + 120;
    let batch = collector(&base, None, false).collect(j).await.expect("ok");
    assert!(batch.items.is_empty());
    assert_live_contract(&batch);
    assert!(batch.live.expect("live").failed.contains(BLUDV_LIVE_KEY));
}

#[tokio::test]
async fn desligado_nao_e_falha_viva() {
    let (fake, base) = start().await;
    let cfg = BludvConfig {
        enabled: false,
        ..config(&base)
    };
    let batch = BludvCollector::new(BludvClient::new(cfg).expect("client"))
        .collect(job(&["Matrix"], false))
        .await
        .expect("ok");
    assert!(batch.items.is_empty());
    assert_live_contract(&batch);
    let live = batch.live.expect("live");
    assert!(live.failed.is_empty());
    assert!(live.empty.is_empty());
    assert!(fake.calls().is_empty(), "kill-switch não vai à rede");
}

#[tokio::test]
async fn dubbed_only_on_e_off_no_coletor() {
    let (_fake, base) = start().await;
    let both = collect(&base, false, job(&["Matrix"], false)).await;
    assert_eq!(both.items.len(), 2);
    let dubbed = collect(&base, false, job(&["Matrix"], true)).await;
    assert_eq!(dubbed.items.len(), 1);
    assert_eq!(dubbed.items[0].extra.get("audio"), Some(&json!("dublado")));
}

#[tokio::test]
async fn raw_v1_so_no_caminho_vivo() {
    let (fake, base) = start().await;
    let store = Arc::new(RecordingStore::default());

    // Vivo: grava na primeira e lê na segunda sem voltar à rede.
    let live = collector(&base, Some(store.clone()), false);
    let first = live.collect(job(&["Matrix"], false)).await.expect("ok");
    assert_eq!(first.items.len(), 2);
    assert_eq!(store.sets.load(Ordering::SeqCst), 1);
    let calls = fake.calls().len();
    let second = live.collect(job(&["Matrix"], false)).await.expect("ok");
    assert_eq!(second.items, first.items);
    assert_eq!(fake.calls().len(), calls, "hit do raw:v1 não vai à rede");

    // Sombra: zera os contadores e NÃO lê nem grava.
    let shadow_store = Arc::new(RecordingStore::default());
    let shadow = collector(&base, Some(shadow_store.clone()), true);
    let batch = shadow.collect(job(&["Matrix"], false)).await.expect("ok");
    assert_eq!(batch.items.len(), 2);
    assert_eq!(shadow_store.gets.load(Ordering::SeqCst), 0);
    assert_eq!(shadow_store.sets.load(Ordering::SeqCst), 0);
    assert!(shadow_store.inner.is_empty());
}
