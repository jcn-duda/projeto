//! Fontes do drain contra HTTP local. Zero rede real.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::WorkTarget;
use adom_harvest::{HarvestEntry, HarvestMediaType};
use adom_search::orchestrator::harvest_support::{raw_items_from_jackett, release_entry_for};
use adom_search::orchestrator::{RawItem, SearchMeta};
use adom_sources::{BludvClient, BludvConfig, JackettRawItem, MemoryRawStore, RawStore};
use adom_store::{RecordOptions, ReleaseIndexStore};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use super::{bludv_query, collect_bludv, merge_source_items, source_plan, SourcePlan};

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW: i64 = 1_700_000_000_000;

#[derive(Clone)]
struct FakeBludv {
    inner: Arc<Inner>,
}

struct Inner {
    calls: Mutex<Vec<String>>,
    mode: Mutex<Mode>,
    base: Mutex<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Ok,
    Empty,
    Http500,
    Hang,
}

#[derive(Deserialize)]
struct SearchQuery {
    s: Option<String>,
}

impl FakeBludv {
    async fn start() -> (Self, String) {
        let api = Self {
            inner: Arc::new(Inner {
                calls: Mutex::new(Vec::new()),
                mode: Mutex::new(Mode::Ok),
                base: Mutex::new(String::new()),
            }),
        };
        let app = Router::new()
            .route("/", get(search))
            .route("/filme/{slug}", get(post))
            .route("/systemads/{id}", get(protector))
            .with_state(api.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let base = format!("http://{addr}");
        *api.inner.base.lock().expect("base") = base.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (api, base)
    }

    fn set_mode(&self, mode: Mode) {
        *self.inner.mode.lock().expect("mode") = mode;
    }

    fn calls(&self) -> Vec<String> {
        self.inner.calls.lock().expect("calls").clone()
    }

    fn push(&self, path: String) {
        self.inner.calls.lock().expect("calls").push(path);
    }
}

async fn search(State(api): State<FakeBludv>, Query(q): Query<SearchQuery>) -> Response {
    api.push(format!("/?s={}", q.s.as_deref().unwrap_or("")));
    let mode = *api.inner.mode.lock().expect("mode");
    match mode {
        Mode::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
            StatusCode::OK.into_response()
        }
        Mode::Http500 => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        Mode::Empty => Html("<html></html>").into_response(),
        Mode::Ok => {
            let base = api.inner.base.lock().expect("base").clone();
            Html(format!(
                r#"<div class="post"><div class="title">
                  <a href="{base}/filme/coringa">Coringa (2019)</a>
                </div></div>"#
            ))
            .into_response()
        }
    }
}

async fn post(State(api): State<FakeBludv>, Path(slug): Path<String>) -> Response {
    api.push(format!("/filme/{slug}"));
    let base = api.inner.base.lock().expect("base").clone();
    Html(format!(
        r#"VERSÃO MKV DUAL ÁUDIO WEB-DL 1080p (3.39 GB - MKV)
        <a href="{base}/systemads/a">DL</a>"#
    ))
    .into_response()
}

async fn protector(State(api): State<FakeBludv>, Path(id): Path<String>) -> Response {
    api.push(format!("/protector/{id}"));
    Html(format!(
        r#"<a href="magnet:?xt=urn:btih:{HASH}&amp;dn=x">x</a>"#
    ))
    .into_response()
}

fn test_config(base: &str) -> BludvConfig {
    BludvConfig {
        enabled: true,
        base_url: base.trim_end_matches('/').to_string(),
        timeout_ms: 1_500,
        allow_private_url: true,
        ..BludvConfig::default()
    }
}

fn full() -> HarvestEntry {
    HarvestEntry {
        imdb_id: "tt7286456".into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "miss".into(),
        enqueued_at: NOW,
        priority_at: None,
        resumed: false,
        br_probe: false,
        full_base: false,
        full_intent: None,
    }
}

fn probe() -> HarvestEntry {
    let mut entry = full();
    entry.br_probe = true;
    entry
}

fn meta(pt: Option<&str>, query: &str) -> SearchMeta {
    SearchMeta {
        query: query.into(),
        pt_query: pt.map(str::to_string),
        name: "Coringa".into(),
        ..SearchMeta::default()
    }
}

fn client(base: &str) -> BludvClient {
    BludvClient::new(test_config(base)).expect("client")
}

#[test]
fn query_pt_prefere_titulo_br() {
    assert_eq!(
        bludv_query(&meta(Some("Coringa 2019"), "Joker 2019")),
        "Coringa 2019"
    );
    assert_eq!(bludv_query(&meta(Some("  "), "Joker 2019")), "Joker 2019");
    assert_eq!(bludv_query(&meta(None, "Joker 2019")), "Joker 2019");
}

#[test]
fn desfecho_2_7_bludv_nao_certifica_jackett() {
    assert_eq!(source_plan(0, false), SourcePlan::FailNoWrite);
    assert_eq!(source_plan(0, true), SourcePlan::Write { ok: false });
    assert_eq!(source_plan(2, false), SourcePlan::OkNoWrite);
    assert_eq!(source_plan(2, true), SourcePlan::Write { ok: true });
    assert!(
        !super::super::drain_shape::jackett_targets_complete(3, 0),
        "BLUDV útil não completa alvo Jackett"
    );
}

#[tokio::test]
async fn full_sucesso_e_vazio() {
    let (api, base) = FakeBludv::start().await;
    let got = collect_bludv(
        Some(&client(&base)),
        &full(),
        &meta(Some("Coringa"), "Joker"),
    )
    .await;
    assert_eq!(got.len(), 1);
    assert!(got[0].hash().eq_ignore_ascii_case(HASH));
    assert!(!got[0].from_account);
    assert!(!api.calls().is_empty());

    api.set_mode(Mode::Empty);
    let empty = collect_bludv(Some(&client(&base)), &full(), &meta(None, "Nada")).await;
    assert!(empty.is_empty(), "Ok([]) não vira sucesso");
}

#[tokio::test]
async fn falha_timeout_kill_switch_e_url_bloqueada() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::Http500);
    assert!(
        collect_bludv(Some(&client(&base)), &full(), &meta(None, "X"))
            .await
            .is_empty()
    );

    api.set_mode(Mode::Hang);
    let hang = BludvClient::new(BludvConfig {
        timeout_ms: 80,
        ..test_config(&base)
    })
    .expect("client");
    assert!(collect_bludv(Some(&hang), &full(), &meta(None, "X"))
        .await
        .is_empty());

    let before = api.calls().len();
    let off = BludvClient::new(BludvConfig {
        enabled: false,
        ..test_config(&base)
    })
    .expect("client");
    assert!(collect_bludv(Some(&off), &full(), &meta(None, "X"))
        .await
        .is_empty());
    assert_eq!(api.calls().len(), before, "FULL desabilitado = zero rede");

    let blocked = BludvClient::new(BludvConfig {
        allow_private_url: false,
        ..test_config(&base)
    })
    .expect("client");
    assert!(collect_bludv(Some(&blocked), &full(), &meta(None, "X"))
        .await
        .is_empty());
    assert_eq!(api.calls().len(), before, "URL bloqueada não consulta");
}

#[tokio::test]
async fn sonda_nao_consulta_bludv() {
    let (api, base) = FakeBludv::start().await;
    let got = collect_bludv(
        Some(&client(&base)),
        &probe(),
        &meta(Some("Coringa"), "Joker"),
    )
    .await;
    assert!(got.is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn fallback_pt_en_na_query() {
    let (api, base) = FakeBludv::start().await;
    let _ = collect_bludv(
        Some(&client(&base)),
        &full(),
        &meta(Some("Coringa 2019"), "Joker 2019"),
    )
    .await;
    assert!(
        api.calls().iter().any(|c| c.contains("Coringa")),
        "{:?}",
        api.calls()
    );
    let _ = collect_bludv(Some(&client(&base)), &full(), &meta(None, "Joker 2019")).await;
    assert!(
        api.calls().iter().any(|c| c.contains("Joker")),
        "{:?}",
        api.calls()
    );
}

#[tokio::test]
async fn raw_hit_sem_nova_rede() {
    let (api, base) = FakeBludv::start().await;
    let store = Arc::new(MemoryRawStore::new());
    let client = BludvClient::new(test_config(&base))
        .expect("client")
        .with_raw_store(store as Arc<dyn RawStore>);
    let q = meta(Some("Coringa 2019"), "Joker 2019");
    assert_eq!(collect_bludv(Some(&client), &full(), &q).await.len(), 1);
    let first = api.calls().len();
    assert!(first > 0);
    assert_eq!(collect_bludv(Some(&client), &full(), &q).await.len(), 1);
    assert_eq!(api.calls().len(), first, "segunda chamada lê o raw");
}

fn jackett_item(hash: &str, from_account: bool) -> RawItem {
    let mut item = raw_items_from_jackett(vec![JackettRawItem {
        title: "Coringa 2019 1080p Dublado".into(),
        magnet: Some(format!("magnet:?xt=urn:btih:{hash}&dn=x")),
        info_hash: Some(hash.to_string()),
        seeders: Some(4.0),
        size: Some(1_000.0),
        published_at: None,
        tracker: None,
        indexer: "bludv".into(),
        download_url: None,
        is_br: true,
    }])
    .remove(0);
    item.from_account = from_account;
    item
}

#[test]
fn mesmo_hash_nao_duplica_e_conta_fica_fora() {
    let other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let jackett = jackett_item(HASH, false);
    let account = jackett_item(other, true);
    let bludv = RawItem {
        title: Some("Coringa 2019 [1080p WEB-DL DUBLADO]".into()),
        magnet: Some(format!("magnet:?xt=urn:btih:{HASH}&dn=x")),
        tracker: Some("BLUDV".into()),
        is_br: true,
        seeders: Some(1.0),
        ..RawItem::default()
    };
    let merged = merge_source_items(vec![jackett, account.clone()], vec![bludv, account]);
    assert_eq!(merged.len(), 2, "mesmo hash fica para o filtro decidir");
    assert!(!merged.iter().any(|item| item.from_account));
    assert!(merged.iter().all(|item| item.hash() == HASH));
    let kept = super::dedupe_by_hash(merged);
    assert_eq!(kept.len(), 1);

    let entry = release_entry_for("tt7286456", "movie", None, None, Some("2019"), &kept, &kept);
    assert!(
        entry
            .items
            .iter()
            .all(|item| item.get("fromAccount").is_none()),
        "fio sem fromAccount"
    );
    let store = ReleaseIndexStore::open_memory().expect("índice");
    let loc = WorkTarget {
        season: None,
        episode: None,
    };
    let novos = store
        .record(
            "tt7286456",
            loc,
            &entry.items,
            RecordOptions::default(),
            store.ttl(),
            store.max_releases(),
            NOW,
            None,
        )
        .expect("grava");
    assert_eq!(novos, 1);
    let found = store.lookup("tt7286456", loc, NOW);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].hash, HASH);
}
