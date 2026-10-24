//! Cliente BLUDV contra servidor falso (axum) — busca WordPress, protetor,
//! filtro dubbed_only, gate pulado, hop SSRF skip, redirect follow com SSRF
//! por hop, desfecho vivo e `raw:v1` (grava/lê).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_sources::{
    BludvClient, BludvConfig, BludvOutcome, BludvSearchOpts, MemoryRawStore, RawStore,
};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

#[derive(Clone)]
struct FakeBludv {
    inner: Arc<Inner>,
}

struct Inner {
    calls: Mutex<Vec<String>>,
    mode: Mutex<Mode>,
    base: Mutex<String>,
    /// Link extra injetado no HTML do post (hop SSRF / esquema inválido).
    extra_link: Mutex<Option<String>>,
    /// Alvo do 302 quando o modo é `RedirectSsrf`.
    redirect_to: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Mode {
    #[default]
    Ok,
    Http500,
    Hang,
    /// Protetor responde 302 para `/redirect-target` — o `follow` do TS segue.
    RedirectHop,
    /// Protetor responde 302 para o alvo privado — a guarda SSRF barra o hop.
    RedirectSsrf,
    /// Post só com o portão de anúncio (nenhum botão legado).
    GateOnly,
    /// Post sem portão: lote completo e cacheável (como o Node).
    Clean,
}

#[derive(Debug, Deserialize)]
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
                extra_link: Mutex::new(None),
                redirect_to: Mutex::new(None),
            }),
        };
        let app = Router::new()
            .route("/", get(search))
            .route("/filme/{slug}", get(post))
            .route("/systemads/{id}", get(protector))
            .route("/videosad/{id}", get(protector))
            .route("/gate/go/{token}", get(gate))
            .route("/redirect-target", get(redirect_target))
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

    fn set_extra_link(&self, url: Option<String>) {
        *self.inner.extra_link.lock().expect("extra") = url;
    }

    fn set_redirect_to(&self, url: Option<String>) {
        *self.inner.redirect_to.lock().expect("redirect") = url;
    }

    fn calls(&self) -> Vec<String> {
        self.inner.calls.lock().expect("calls").clone()
    }

    fn base(&self) -> String {
        self.inner.base.lock().expect("base").clone()
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
        Mode::Ok | Mode::RedirectHop | Mode::RedirectSsrf | Mode::GateOnly | Mode::Clean => {
            let base = api.base();
            Html(format!(
                r#"
                <div class="post"><div class="title">
                  <a href="{base}/filme/coringa">Coringa (2019)</a>
                </div></div>
                "#
            ))
            .into_response()
        }
    }
}

async fn post(State(api): State<FakeBludv>, Path(slug): Path<String>) -> Response {
    api.push(format!("/filme/{slug}"));
    let base = api.base();
    let mode = *api.inner.mode.lock().expect("mode");
    if mode == Mode::GateOnly {
        return Html(format!(
            r#"
            <a href="{base}/gate/go/0646028353024d92?p=60609">Magnet-Link</a>
            "#
        ))
        .into_response();
    }
    let extra = api
        .inner
        .extra_link
        .lock()
        .expect("extra")
        .clone()
        .unwrap_or_default();
    let extra_anchor = if extra.is_empty() {
        String::new()
    } else {
        format!(r#"<a href="{extra}">EVIL</a>"#)
    };
    let gate_anchor = if mode == Mode::Clean {
        String::new()
    } else {
        format!(r#"<a href="{base}/gate/go/0646028353024d92?p=60609">GATE</a>"#)
    };
    // Fixture: dublado (systemads), gate (pulado), legendado (videosad).
    Html(format!(
        r#"
        VERSÃO MKV DUAL ÁUDIO
        WEB-DL 1080p (3.39 GB - MKV)
        <a href="{base}/systemads/a">DL</a>
        {gate_anchor}
        {extra_anchor}
        VERSÃO MP4 LEGENDADO
        WEB-DL 720p (1.2 GB - MP4)
        <a href="{base}/videosad/b">DL</a>
        "#
    ))
    .into_response()
}

async fn protector(State(api): State<FakeBludv>, Path(id): Path<String>) -> Response {
    api.push(format!("/protector/{id}"));
    let mode = *api.inner.mode.lock().expect("mode");
    if mode == Mode::RedirectHop {
        let target = format!("{}/redirect-target", api.base());
        return Redirect::temporary(target.as_str()).into_response();
    }
    if mode == Mode::RedirectSsrf {
        let target = api
            .inner
            .redirect_to
            .lock()
            .expect("redirect")
            .clone()
            .unwrap_or_default();
        return Redirect::temporary(target.as_str()).into_response();
    }
    let hash = if id == "b" { HASH_B } else { HASH };
    Html(format!(
        r#"<a href="magnet:?xt=urn:btih:{hash}&amp;dn=x">x</a>"#
    ))
    .into_response()
}

async fn redirect_target(State(api): State<FakeBludv>) -> Response {
    api.push("/redirect-target".into());
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/html")],
        format!(r#"<a href="magnet:?xt=urn:btih:{HASH}&amp;dn=x">x</a>"#),
    )
        .into_response()
}

async fn gate(State(api): State<FakeBludv>) -> Response {
    api.push("/gate".into());
    Html("gate").into_response()
}

fn test_config(base: &str) -> BludvConfig {
    BludvConfig {
        enabled: true,
        base_url: base.trim_end_matches('/').to_string(),
        max_posts: 3,
        max_links_per_post: 12,
        concurrency: 6,
        timeout_ms: 1_500,
        allow_private_url: true,
        ..BludvConfig::default()
    }
}

#[derive(Default)]
struct RecordingStore {
    inner: MemoryRawStore,
    gets: AtomicUsize,
    sets: AtomicUsize,
}

impl RecordingStore {
    fn gets(&self) -> usize {
        self.gets.load(Ordering::SeqCst)
    }

    fn sets(&self) -> usize {
        self.sets.load(Ordering::SeqCst)
    }

    fn keys(&self) -> Vec<String> {
        self.inner.keys()
    }
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

#[tokio::test]
async fn enabled_false_sem_rede() {
    let (api, base) = FakeBludv::start().await;
    let cfg = BludvConfig {
        enabled: false,
        ..test_config(&base)
    };
    let client = BludvClient::new(cfg).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert!(out.is_empty());
    assert!(api.calls().is_empty());
    assert_eq!(
        client
            .search_outcome("Coringa", &BludvSearchOpts::default())
            .await,
        BludvOutcome::Disabled
    );
}

#[tokio::test]
async fn busca_resolve_protetor_e_pula_gate() {
    let (api, base) = FakeBludv::start().await;
    let client = BludvClient::new(test_config(&base)).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert_eq!(out.len(), 2);
    assert!(out[0].magnet.contains(HASH));
    assert!(out[1].magnet.contains(HASH_B));
    assert_eq!(out[0].tracker, "BLUDV");
    assert!(out[0].is_br);
    assert_eq!(out[0].seeders, 1.0);
    assert_eq!(out[0].audio, "dublado");
    assert_eq!(out[1].audio, "legendado");
    assert_eq!(out[0].size, Some((3.39 * 1024.0_f64.powi(3)).round()));
    // Título = post limpo + tag do BOTÃO (releaseTitle do Node).
    assert_eq!(out[0].title, "Coringa (2019) [1080p WEB-DL DUBLADO]");
    assert_eq!(out[1].title, "Coringa (2019) [720p WEB-DL LEGENDADO]");
    assert!(
        !api.calls().iter().any(|c| c.contains("gate")),
        "gate não deve ser fetchado: {:?}",
        api.calls()
    );
    assert!(api.calls().iter().any(|c| c.contains("/protector/a")));
    assert!(api.calls().iter().any(|c| c.contains("/protector/b")));
}

#[tokio::test]
async fn dubbed_only_filtra_legendado() {
    let (_api, base) = FakeBludv::start().await;
    let client = BludvClient::new(test_config(&base)).expect("client");
    let out = client
        .search("Coringa", &BludvSearchOpts { dubbed_only: true })
        .await;
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].audio, "dublado");
    assert!(out[0].magnet.contains(HASH));
}

#[tokio::test]
async fn http_500_fail_open_e_outcome() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::Http500);
    let client = BludvClient::new(test_config(&base)).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert!(out.is_empty());
    assert_eq!(
        client
            .search_outcome("Coringa", &BludvSearchOpts::default())
            .await,
        BludvOutcome::Http(500)
    );
}

// Parte 2 em `tests/parts/`: todo `tests/*.rs` de primeiro nível vira um
// alvo de teste próprio no cargo, então o subarquivo mora na subpasta.
#[path = "parts/bludv_part2.rs"]
mod part2;
