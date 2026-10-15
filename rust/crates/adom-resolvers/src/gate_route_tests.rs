//! Testes do /resolve sem rede e sem HTTP server: o handler e chamado direto
//! (State + Query montados a mao) e os callbacks simulam o comportamento do
//! gate. Cobre o contrato de status da pendencia (503), o parâmetro `wait=1`
//! e o caminho direto do portão (`p`).

use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::server::{ResolverCallbacks, SearchItems, UnwrapSeed, UnwrappedUrl};

/// Callbacks que reproduzem a decisão do gate no `resolve_button`: no modo
/// bloqueante devolve o magnet (como se esperasse a cadeia); no modo kick
/// devolve a pendência. Igual ao `resolve_gate` real.
struct GateStub {
    fail_with: Option<&'static str>,
    resolved: AtomicUsize,
    gate_direct: AtomicUsize,
}

impl GateStub {
    fn new() -> Self {
        Self {
            fail_with: None,
            resolved: AtomicUsize::new(0),
            gate_direct: AtomicUsize::new(0),
        }
    }
    fn failing(msg: &'static str) -> Self {
        Self {
            fail_with: Some(msg),
            resolved: AtomicUsize::new(0),
            gate_direct: AtomicUsize::new(0),
        }
    }
}

#[async_trait::async_trait]
impl ResolverCallbacks for GateStub {
    async fn search(&self, _q: &str) -> Result<SearchItems, String> {
        Ok(Vec::new())
    }
    fn render_html(&self, _items: &SearchItems) -> String {
        String::new()
    }
    async fn resolve_best(&self, _url: &str) -> Result<String, String> {
        Err("no_links".to_string())
    }
    async fn resolve_button(
        &self,
        _url: &str,
        _index: usize,
        _hash: Option<&str>,
        _count: Option<&str>,
    ) -> Result<String, String> {
        self.resolved.fetch_add(1, Ordering::SeqCst);
        if let Some(msg) = self.fail_with {
            return Err(msg.to_string());
        }
        if gate_wait_block_requested() {
            Ok("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567".to_string())
        } else {
            Err(GATE_PENDING.to_string())
        }
    }
    async fn resolve_gate_direct(&self, _gate: &str, _post: &str) -> Result<String, String> {
        self.gate_direct.fetch_add(1, Ordering::SeqCst);
        if let Some(msg) = self.fail_with {
            return Err(msg.to_string());
        }
        if gate_wait_block_requested() {
            Ok("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567".to_string())
        } else {
            Err(GATE_PENDING.to_string())
        }
    }
    fn unwrap_resolver_url(&self, value: &str, seed: UnwrapSeed) -> Result<UnwrappedUrl, String> {
        Ok(UnwrappedUrl {
            url: value.to_string(),
            index: seed.index.and_then(|i| i.parse::<usize>().ok()),
            hash: seed.hash,
            count: seed.count,
        })
    }
    fn caps_xml(&self) -> String {
        String::new()
    }
    fn empty_xml(&self, _category: u32, _type_: &str) -> String {
        String::new()
    }
    fn render_xml(&self, _items: &SearchItems, _category: u32) -> String {
        String::new()
    }
}

async fn call(url: &str, index: Option<&str>, wait: Option<&str>) -> Response {
    let callbacks: Arc<dyn ResolverCallbacks> = Arc::new(GateStub::new());
    resolve_handler(
        State(callbacks),
        Query(ResolveQuery {
            url: Some(url.to_string()),
            i: index.map(str::to_string),
            h: None,
            n: None,
            p: None,
            wait: wait.map(str::to_string),
        }),
    )
    .await
}

/// Fluxo do executor do raspador: `url` é o BOTÃO do gate, `p` o post.
async fn call_p(
    url: &str,
    post: &str,
    wait: Option<&str>,
    index: Option<&str>,
) -> (Response, Arc<GateStub>) {
    let stub = Arc::new(GateStub::new());
    let callbacks: Arc<dyn ResolverCallbacks> = stub.clone();
    let resp = resolve_handler(
        State(callbacks),
        Query(ResolveQuery {
            url: Some(url.to_string()),
            i: index.map(str::to_string),
            h: None,
            n: None,
            p: Some(post.to_string()),
            wait: wait.map(str::to_string),
        }),
    )
    .await;
    (resp, stub)
}

/// Sem wait e com o gate pendente: 503 "gate_pending" NA HORA (o stub não
/// espera nada — se o handler bloqueasse, o teste não terminaria em 0 cadeias).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gate_pendente_responde_503_sem_esperar() {
    let resp = call("https://bludvfilmes1.xyz/post/", Some("0"), None).await;
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(resp.into_body(), 64).await.unwrap();
    assert_eq!(&body[..], b"gate_pending");
}

/// wait=1: modo bloqueante — o magnet volta no 200, como antes.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_1_bloqueia_e_devolve_magnet() {
    let resp = call("https://bludvfilmes1.xyz/post/", Some("0"), Some("1")).await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 512).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("magnet:?xt=urn:btih:"));
}

/// Erro comum (não-pendência) continua 502: só `gate_pending` vira 503.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn erro_comum_continua_502() {
    let callbacks: Arc<dyn ResolverCallbacks> = Arc::new(GateStub::failing("no_such_button"));
    let resp = resolve_handler(
        State(callbacks),
        Query(ResolveQuery {
            url: Some("https://bludvfilmes1.xyz/post/".to_string()),
            i: Some("0".to_string()),
            h: None,
            n: None,
            p: None,
            wait: Some("1".to_string()),
        }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
}

/// url vazia continua 400, com ou sem wait.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn url_invalida_continua_400() {
    let resp = call("", Some("0"), None).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let resp = call("", Some("0"), Some("1")).await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

/// Caminho direto do portão (`p` + sem `i`) com wait=1: o magnet volta no 200
/// e NUNCA passa pelo resolve_button/resolve_best (o post não é reaberto).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gate_direto_com_p_espera_e_devolve_magnet() {
    let (resp, stub) = call_p(
        "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609",
        "https://bludvfilmes1.xyz/post/",
        Some("1"),
        None,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 512).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("magnet:?xt=urn:btih:"));
    assert_eq!(stub.gate_direct.load(Ordering::SeqCst), 1);
    assert_eq!(stub.resolved.load(Ordering::SeqCst), 0);
}

/// Mesmo caminho sem wait: 503 gate_pending na hora — o executor do raspador
/// trata pendência e volta na rodada seguinte (o aquecimento já ficou em curso).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gate_direto_sem_wait_responde_503() {
    let (resp, stub) = call_p(
        "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609",
        "https://bludvfilmes1.xyz/post/",
        None,
        None,
    )
    .await;
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(resp.into_body(), 64).await.unwrap();
    assert_eq!(&body[..], b"gate_pending");
    assert_eq!(stub.gate_direct.load(Ordering::SeqCst), 1);
}

/// `p` junto com `i`: o fluxo antigo do botão vence (o caminho direto é só
/// sem índice) — o `p` é ignorado.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p_com_indice_cai_no_fluxo_do_botao() {
    let (resp, stub) = call_p(
        "https://bludvfilmes1.xyz/post/",
        "https://bludvfilmes1.xyz/post/",
        Some("1"),
        Some("0"),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(stub.resolved.load(Ordering::SeqCst), 1);
    assert_eq!(stub.gate_direct.load(Ordering::SeqCst), 0);
}

/// Erro real no caminho direto continua 502 (só `gate_pending` vira 503).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gate_direto_erro_continua_502() {
    let stub = Arc::new(GateStub::failing("botao invalido"));
    let callbacks: Arc<dyn ResolverCallbacks> = stub.clone();
    let resp = resolve_handler(
        State(callbacks),
        Query(ResolveQuery {
            url: Some("https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609".to_string()),
            i: None,
            h: None,
            n: None,
            p: Some("https://bludvfilmes1.xyz/post/".to_string()),
            wait: Some("1".to_string()),
        }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(stub.gate_direct.load(Ordering::SeqCst), 1);
}

/// `p` vazio não é caminho direto: cai no fluxo antigo (sem índice →
/// resolve_best, que no stub devolve no_links → 502).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn p_vazio_nao_e_caminho_direto() {
    let stub = Arc::new(GateStub::new());
    let callbacks: Arc<dyn ResolverCallbacks> = stub.clone();
    let resp = resolve_handler(
        State(callbacks),
        Query(ResolveQuery {
            url: Some("https://bludvfilmes1.xyz/post/".to_string()),
            i: None,
            h: None,
            n: None,
            p: Some("   ".to_string()),
            wait: None,
        }),
    )
    .await;
    assert_eq!(resp.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(stub.gate_direct.load(Ordering::SeqCst), 0);
}
