//! Cliente BLUDV contra servidor falso (axum) — busca WordPress, protetor,
//! filtro dubbed_only, gate pulado, hop SSRF skip, redirect follow com SSRF
//! por hop, desfecho vivo e `raw:v1` (vivo grava/lê; read-only não toca).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_sources::{
    BludvClient, BludvConfig, BludvOutcome, BludvSearchOpts, MemoryRawStore, RawStore,
    BLUDV_DEFAULT_URL,
};
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::json;

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
        .search(
            "Coringa",
            &BludvSearchOpts {
                dubbed_only: true,
                ..BludvSearchOpts::default()
            },
        )
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

#[tokio::test]
async fn timeout_fail_open_e_outcome() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::Hang);
    let cfg = BludvConfig {
        timeout_ms: 80,
        ..test_config(&base)
    };
    let client = BludvClient::new(cfg).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert!(out.is_empty());
    assert!(matches!(
        client
            .search_outcome("Coringa", &BludvSearchOpts::default())
            .await,
        BludvOutcome::Failed(_)
    ));
}

#[tokio::test]
async fn ssrf_barra_loopback_sem_allow_private() {
    let (api, base) = FakeBludv::start().await;
    let cfg = BludvConfig {
        allow_private_url: false,
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
        BludvOutcome::BlockedUrl
    );
}

/// Hop privado fora da origem (protetor SSRF no HTML) → skip sem GET no trap.
#[tokio::test]
async fn hop_inseguro_no_post_skip_sem_get() {
    let trap_hits = Arc::new(AtomicUsize::new(0));
    let hits_h = trap_hits.clone();
    let trap_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind trap");
    let trap_addr = trap_listener.local_addr().expect("addr");
    let evil = format!("http://{trap_addr}/systemads/evil");
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = trap_listener.accept().await else {
                break;
            };
            hits_h.fetch_add(1, Ordering::SeqCst);
            let _ = sock.try_write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        }
    });

    let (api, base) = FakeBludv::start().await;
    api.set_extra_link(Some(evil));
    // allow_private libera só a origem da base — o trap (outra porta) cai.
    let client = BludvClient::new(test_config(&base)).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert_eq!(out.len(), 2, "links da mesma origem seguem: {out:?}");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        trap_hits.load(Ordering::SeqCst),
        0,
        "hop SSRF não pode ter recebido GET"
    );
}

/// `redirect: follow` do TS: o 302 do protetor é seguido e o magnet do alvo
/// entra na lista.
#[tokio::test]
async fn redirect_follow_segue_hop() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::RedirectHop);
    let client = BludvClient::new(test_config(&base)).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert_eq!(out.len(), 2, "follow deve produzir magnet: {out:?}");
    assert!(api.calls().iter().any(|c| c.contains("redirect-target")));
}

/// Redirect para privado FORA da origem: a guarda SSRF roda em cada hop e o
/// alvo nunca recebe GET.
#[tokio::test]
async fn redirect_para_privado_fora_da_origem_nao_segue() {
    let trap_hits = Arc::new(AtomicUsize::new(0));
    let hits_h = trap_hits.clone();
    let trap_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind trap");
    let trap_addr = trap_listener.local_addr().expect("addr");
    let target = format!("http://{trap_addr}/systemads/redirected");
    tokio::spawn(async move {
        loop {
            let Ok((sock, _)) = trap_listener.accept().await else {
                break;
            };
            hits_h.fetch_add(1, Ordering::SeqCst);
            let _ = sock.try_write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        }
    });

    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::RedirectSsrf);
    api.set_redirect_to(Some(target));
    let client = BludvClient::new(test_config(&base)).expect("client");
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert!(out.is_empty(), "redirect privado não pode render magnet");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        trap_hits.load(Ordering::SeqCst),
        0,
        "redirect SSRF não pode ter recebido GET"
    );
}

/// `raw:v1`: o caminho vivo grava, o segundo scrape lê o cache e não vai à
/// rede de novo; a chave carrega a flag de dublado como no Node.
#[tokio::test]
async fn raw_v1_vivo_grava_e_le() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::Clean);
    let store = Arc::new(RecordingStore::default());
    let client = BludvClient::new(test_config(&base))
        .expect("client")
        .with_raw_store(store.clone());

    let first = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert_eq!(first.len(), 2);
    assert_eq!(store.sets(), 1);
    assert_eq!(
        store.keys(),
        vec!["raw:v1:bludv:t:Coringa".to_string()],
        "chave = raw:v1:bludv:<d|t>:<query>"
    );

    let calls = api.calls().len();
    let second = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert_eq!(second, first, "cache devolve os mesmos itens");
    assert_eq!(store.gets(), 2, "1ª busca: miss; 2ª: hit do raw:v1");
    assert_eq!(api.calls().len(), calls, "hit do raw:v1 não vai à rede");

    // Flag de dublado muda a chave (o scrape filtra legendado ANTES de gravar).
    let dubbed = client
        .search(
            "Coringa",
            &BludvSearchOpts {
                dubbed_only: true,
                ..BludvSearchOpts::default()
            },
        )
        .await;
    assert_eq!(dubbed.len(), 1);
    assert!(store
        .keys()
        .iter()
        .any(|key| key == "raw:v1:bludv:d:Coringa"));
}

/// Sombra read-only: NÃO lê nem grava `raw:v1`, mesmo com o store injetado.
#[tokio::test]
async fn read_only_nao_le_nem_grava_raw_v1() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::Clean);
    let store = Arc::new(RecordingStore::default());
    let client = BludvClient::new(test_config(&base))
        .expect("client")
        .with_raw_store(store.clone());

    let out = client
        .search(
            "Coringa",
            &BludvSearchOpts {
                read_only: true,
                ..BludvSearchOpts::default()
            },
        )
        .await;
    assert_eq!(out.len(), 2);
    assert!(!api.calls().is_empty(), "read-only continua raspando");
    assert_eq!(store.gets(), 0, "read-only não lê raw:v1");
    assert_eq!(store.sets(), 0, "read-only não grava raw:v1");
    assert!(store.keys().is_empty());
}

/// Post com portão de anúncio não vira cache cru de longa duração
/// (`incomplete` no brief do Node).
#[tokio::test]
async fn gate_nao_cacheia_raw_v1() {
    let (api, base) = FakeBludv::start().await;
    api.set_mode(Mode::GateOnly);
    let store = Arc::new(RecordingStore::default());
    let client = BludvClient::new(test_config(&base))
        .expect("client")
        .with_raw_store(store.clone());
    let out = client.search("Coringa", &BludvSearchOpts::default()).await;
    assert!(out.is_empty());
    assert_eq!(store.sets(), 0, "lote incompleto (gate) não grava");
}

#[tokio::test]
async fn query_vazia_sem_rede() {
    let (api, base) = FakeBludv::start().await;
    let client = BludvClient::new(test_config(&base)).expect("client");
    assert!(client
        .search("   ", &BludvSearchOpts::default())
        .await
        .is_empty());
    assert!(api.calls().is_empty());
}

#[tokio::test]
async fn default_desligado() {
    let cfg = BludvConfig::default();
    assert!(!cfg.enabled);
    assert_eq!(cfg.base_url, BLUDV_DEFAULT_URL);
    assert!(cfg.raw_cache_enabled());
}

#[test]
fn cache_de_obras_serializa_no_formato_do_node() {
    // Guarda o contrato do valor (`{items:[…]}` em camelCase) usado pelo
    // gateway e pelo Node.
    let item = adom_sources::BludvRawItem {
        title: "Filme 2024 [1080p WEB-DL DUBLADO]".into(),
        magnet: format!("magnet:?xt=urn:btih:{HASH}&dn=x"),
        seeders: 1.0,
        size: Some(1_000.0),
        tracker: "BLUDV".into(),
        audio: "dublado".into(),
        is_br: true,
    };
    let value = json!({ "items": [item] });
    assert_eq!(value["items"][0]["tracker"], json!("BLUDV"));
    assert_eq!(value["items"][0]["isBr"], json!(true));
    assert_eq!(value["items"][0]["audio"], json!("dublado"));
}
