use super::*;
use crate::sites::bludv::gate_transport::{FlareGetResult, GetResult};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const GATE_HOST: &str = "bludvfilmes1.xyz";
const VALID_MAGNET: &str = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Scenario {
    Ok,
    BadJump,
    BadShortener,
    BadApi,
    BadCallback,
    MultiRef,
    NoMagnet,
}

struct MockTransport {
    scenario: Scenario,
    gate_host: String,
    chain_runs: Arc<AtomicUsize>,
    destroyed: Arc<AtomicBool>,
}

impl MockTransport {
    fn build(scenario: Scenario) -> (Arc<dyn GateTransport>, Arc<AtomicUsize>, Arc<AtomicBool>) {
        let runs = Arc::new(AtomicUsize::new(0));
        let destroyed = Arc::new(AtomicBool::new(false));
        let t: Arc<dyn GateTransport> = Arc::new(MockTransport {
            scenario,
            gate_host: GATE_HOST.to_string(),
            chain_runs: Arc::clone(&runs),
            destroyed: Arc::clone(&destroyed),
        });
        (t, runs, destroyed)
    }
}

fn gate_url(p: &str) -> String {
    format!("https://{GATE_HOST}/gate/go/0646028353024d92?p={p}")
}
fn post_url() -> String {
    format!("https://{GATE_HOST}/post/")
}
fn cfg(min_wait_ms: u64) -> GateConfig {
    GateConfig {
        solver_url: "http://127.0.0.1:8191".into(),
        timeout: Duration::from_secs(5),
        min_wait: Duration::from_millis(min_wait_ms),
    }
}

#[async_trait::async_trait]
impl GateTransport for MockTransport {
    async fn create_session(&self) -> GateResult<()> {
        self.chain_runs.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn flare_get(&self, value: &str, guard: &UrlGuard) -> GateResult<FlareGetResult> {
        let out_url = if value.contains("/gate/callback") {
            Url::parse(value).map_err(|_| GateError::refused("callback invalido"))?
        } else if self.scenario == Scenario::BadJump {
            Url::parse("https://evil.example.com/jump/x").unwrap()
        } else {
            Url::parse("https://promobr.online/jump/abc").unwrap()
        };
        if !guard(&out_url) {
            return Err(GateError::refused("destino nao permitido"));
        }
        let html = if value.contains("/gate/callback") {
            match self.scenario {
                Scenario::NoMagnet => "<html>sem saida</html>".to_string(),
                _ => format!(r#"var url = "{VALID_MAGNET}";"#),
            }
        } else {
            String::new()
        };
        Ok(FlareGetResult { url: out_url, html })
    }
    async fn direct_get(&self, value: &str) -> GateResult<GetResult> {
        let url = Url::parse(value).map_err(|_| GateError::refused("url invalida"))?;
        let location = if value.contains("x.gd") {
            match self.scenario {
                Scenario::BadShortener => {
                    Some(Url::parse("https://evil.example.com/r/x?utm_content=1").unwrap())
                }
                _ => Some(
                    Url::parse("https://valedesconto.shop/r/store?utm_content=CODE123").unwrap(),
                ),
            }
        } else {
            match self.scenario {
                Scenario::BadCallback => Some(
                    Url::parse("https://other.example.com/gate/callback?token=T&ref=R").unwrap(),
                ),
                Scenario::MultiRef => Some(
                    Url::parse(&format!(
                        "https://{}/gate/callback?token=T&ref=R&ref=R2",
                        self.gate_host
                    ))
                    .unwrap(),
                ),
                _ => Some(
                    Url::parse(&format!(
                        "https://{}/gate/callback?token=TOK&ref=REF",
                        self.gate_host
                    ))
                    .unwrap(),
                ),
            }
        };
        Ok(GetResult {
            url,
            location,
            html: String::new(),
        })
    }
    async fn follow_text(&self, value: &str, guard: &UrlGuard) -> GateResult<String> {
        let url = Url::parse(value).map_err(|_| GateError::refused("url invalida"))?;
        if !guard(&url) {
            return Err(GateError::refused("destino nao permitido"));
        }
        if value.contains("/jump/") {
            Ok(r#"<a href="https://x.gd/AbC123">ir</a>"#.to_string())
        } else if value.contains("/api/end") {
            Ok(match self.scenario {
                Scenario::BadApi => r#"{"url":"https://promobr.online/nope"}"#.to_string(),
                _ => r#"{"url":"https://promobr.online/hop/XYZ"}"#.to_string(),
            })
        } else if value.contains("/hop/") {
            Ok(r#"<a href="https://promobr.online/go/XYZ">continuar</a>"#.to_string())
        } else {
            Err(GateError::refused("destino nao permitido"))
        }
    }
    async fn destroy_session(&self) {
        self.destroyed.store(true, Ordering::SeqCst);
    }
    fn allowed(&self, value: &str, base: Option<&str>) -> GateResult<Url> {
        check_allowed(&self.gate_host, value, base)
    }
}

fn gate(p: &str) -> Url {
    Url::parse(&gate_url(p)).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cadeia_completa_devolve_magnet() {
    let (t, runs, destroyed) = MockTransport::build(Scenario::Ok);
    let magnet = run_chain(t.as_ref(), &gate("60001"), &cfg(0))
        .await
        .unwrap();
    assert!(magnet.contains("btih:0123456789abcdef"), "magnet: {magnet}");
    assert!(is_valid_magnet_uri_pub(&magnet));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
    assert!(destroyed.load(Ordering::SeqCst), "sessao destruida no fim");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn espera_minima_contada_do_inicio() {
    let (t, _, _) = MockTransport::build(Scenario::Ok);
    let started = Instant::now();
    let r = run_chain(t.as_ref(), &gate("60002"), &cfg(250)).await;
    r.unwrap();
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(250),
        "espera {elapsed:?} < 250ms"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "nao dormiu 30s: {elapsed:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejeita_cada_destino_inseguro() {
    for (scenario, p) in [
        (Scenario::BadJump, "60003"),
        (Scenario::BadShortener, "60004"),
        (Scenario::BadApi, "60005"),
        (Scenario::BadCallback, "60006"),
        (Scenario::MultiRef, "60007"),
        (Scenario::NoMagnet, "60008"),
    ] {
        let (t, _, destroyed) = MockTransport::build(scenario);
        let err = run_chain(t.as_ref(), &gate(p), &cfg(0)).await.unwrap_err();
        assert!(matches!(err, GateError::Refused(_)), "{scenario:?}: {err}");
        assert!(
            destroyed.load(Ordering::SeqCst),
            "{scenario:?}: sessao NAO destruida sob falha"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cache_so_sucesso_e_coalesce_por_url() {
    let (t, runs, _d) = MockTransport::build(Scenario::Ok);
    let url = gate_url("60010");
    let post = post_url();
    let c = cfg(0);
    let a = resolve_gate_magnet(&url, &post, Arc::clone(&t), &c);
    let b = resolve_gate_magnet(&url, &post, Arc::clone(&t), &c);
    let (ra, rb) = tokio::join!(a, b);
    assert_eq!(ra.unwrap(), rb.unwrap());
    assert_eq!(runs.load(Ordering::SeqCst), 1, "coalescing: uma cadeia");
    // terceira chamada cai no cache (mesma cadeia, sem nova sessao)
    let again = resolve_gate_magnet(&url, &post, Arc::clone(&t), &c)
        .await
        .unwrap();
    assert!(again.contains("btih:"));
    assert_eq!(runs.load(Ordering::SeqCst), 1, "cache: nao reexecutou");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn falha_nao_entra_em_cache() {
    let (t, runs, _d) = MockTransport::build(Scenario::BadCallback);
    let url = gate_url("60011");
    let post = post_url();
    let first = resolve_gate_magnet(&url, &post, Arc::clone(&t), &cfg(0)).await;
    assert!(first.is_err());
    let second = resolve_gate_magnet(&url, &post, Arc::clone(&t), &cfg(0)).await;
    assert!(second.is_err());
    assert_eq!(
        runs.load(Ordering::SeqCst),
        2,
        "falha reexecuta, nao cacheou"
    );
}

// Ponte para o validador privado do site (evita duplicar regra no teste).
fn is_valid_magnet_uri_pub(m: &str) -> bool {
    adom_crawl::br_core::magnet::is_valid_magnet_uri(m)
}
