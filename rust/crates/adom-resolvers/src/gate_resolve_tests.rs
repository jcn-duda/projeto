//! Testes do modo de espera do gate (`resolve_gate`): o kick (resposta
//! imediata + aquecimento em fundo) e o bloqueio (`wait=1`). Zero rede: o
//! transport e mockado e conta as cadeias por `create_session` (1 por cadeia).

use super::*;
use crate::sites::bludv::gate_transport::{
    check_allowed, FlareGetResult, GateError, GateResult, GetResult, UrlGuard,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const GATE_HOST: &str = "bludvfilmes1.xyz";
const VALID_MAGNET: &str = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";

#[derive(Clone, Copy, PartialEq)]
enum Scenario {
    /// Cadeia completa ate o magnet.
    Ok,
    /// Callback fora do host do gate: cadeia falha (falha NUNCA cacheia).
    Fail,
}

struct ModeTransport {
    scenario: Scenario,
    gate_host: String,
    chain_runs: Arc<AtomicUsize>,
}

impl ModeTransport {
    fn build(scenario: Scenario) -> (Arc<dyn GateTransport>, Arc<AtomicUsize>) {
        let runs = Arc::new(AtomicUsize::new(0));
        let t: Arc<dyn GateTransport> = Arc::new(ModeTransport {
            scenario,
            gate_host: GATE_HOST.to_string(),
            chain_runs: Arc::clone(&runs),
        });
        (t, runs)
    }
}

#[async_trait::async_trait]
impl GateTransport for ModeTransport {
    async fn create_session(&self) -> GateResult<()> {
        self.chain_runs.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn flare_get(&self, value: &str, guard: &UrlGuard) -> GateResult<FlareGetResult> {
        let out_url = if value.contains("/gate/callback") {
            Url::parse(value).map_err(|_| GateError::refused("callback invalido"))?
        } else {
            Url::parse("https://promobr.online/jump/abc").unwrap()
        };
        if !guard(&out_url) {
            return Err(GateError::refused("destino nao permitido"));
        }
        let html = if value.contains("/gate/callback") {
            match self.scenario {
                Scenario::Fail => "<html>sem saida</html>".to_string(),
                Scenario::Ok => format!(r#"var url = "{VALID_MAGNET}";"#),
            }
        } else {
            String::new()
        };
        Ok(FlareGetResult {
            url: out_url,
            html,
        })
    }
    async fn direct_get(&self, value: &str) -> GateResult<GetResult> {
        let url = Url::parse(value).map_err(|_| GateError::refused("url invalida"))?;
        let location = if value.contains("x.gd") {
            Some(Url::parse("https://valedesconto.shop/r/store?utm_content=CODE123").unwrap())
        } else {
            match self.scenario {
                Scenario::Fail => Some(
                    Url::parse("https://other.example.com/gate/callback?token=T&ref=R").unwrap(),
                ),
                Scenario::Ok => Some(
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
            Ok(r#"{"url":"https://promobr.online/hop/XYZ"}"#.to_string())
        } else if value.contains("/hop/") {
            Ok(r#"<a href="https://promobr.online/go/XYZ">continuar</a>"#.to_string())
        } else {
            Err(GateError::refused("destino nao permitido"))
        }
    }
    async fn destroy_session(&self) {}
    fn allowed(&self, value: &str, base: Option<&str>) -> GateResult<Url> {
        check_allowed(&self.gate_host, value, base)
    }
}

fn profile() -> ResolverProfile {
    ResolverProfile::new("bludv", &format!("https://{GATE_HOST}"), vec![])
}

fn gate_url(p: &str) -> String {
    format!("https://{GATE_HOST}/gate/go/0646028353024d92?p={p}")
}
fn post_url() -> String {
    format!("https://{GATE_HOST}/post/")
}
fn cfg() -> GateConfig {
    GateConfig {
        solver_url: "http://127.0.0.1:8191".into(),
        timeout: Duration::from_secs(5),
        min_wait: Duration::from_millis(0),
    }
}

/// Polla ate a condicao bater ou estourar o prazo: a cadeia em fundo nao tem
/// handle para await direto, e o semaforo/cache sao globais do processo.
async fn wait_until(mut cond: impl FnMut() -> bool, deadline: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < deadline {
        if cond() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    cond()
}

/// (a) Gate sem cache no modo sem wait: pendencia rapida e EXATAMENTE 1 cadeia
/// em fundo (o mock conta as cadeias; nada dispara uma segunda).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kick_sem_cache_responde_pendente_e_dispara_uma_cadeia() {
    let profile = profile();
    let (t, runs) = ModeTransport::build(Scenario::Ok);
    let url = gate_url("61001");
    let post = post_url();
    let started = Instant::now();
    let out = crate::server::with_gate_wait_block(
        false,
        profile.resolve_gate_with(&url, &post, t, &cfg()),
    )
    .await;
    let elapsed = started.elapsed();
    assert_eq!(out.unwrap_err(), GATE_PENDING, "kick devolve pendencia");
    assert!(
        elapsed < Duration::from_secs(1),
        "kick prendeu a requisicao: {elapsed:?}"
    );
    // A cadeia aquecida aparece em fundo e NAO se replica.
    assert!(
        wait_until(|| runs.load(Ordering::SeqCst) == 1, Duration::from_secs(5)).await,
        "cadeia em fundo nao rodou"
    );
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        runs.load(Ordering::SeqCst),
        1,
        "kick disparou mais de uma cadeia"
    );
}

/// (b) Depois do aquecimento, a nova chamada (ainda sem wait) devolve o magnet
/// direto do cache — sem segunda cadeia.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn apos_aquecimento_nova_chamada_devolve_magnet_do_cache() {
    let profile = profile();
    let (t, runs) = ModeTransport::build(Scenario::Ok);
    let url = gate_url("61002");
    let post = post_url();
    let first = crate::server::with_gate_wait_block(
        false,
        profile.resolve_gate_with(&url, &post, Arc::clone(&t), &cfg()),
    )
    .await;
    assert_eq!(first.unwrap_err(), GATE_PENDING);
    // O aquecimento grava o cache no sucesso; a leitura usa a MESMA chave.
    assert!(
        wait_until(
            || gate_flow::gate_cache_lookup(&url, &post)
                .ok()
                .flatten()
                .is_some(),
            Duration::from_secs(5)
        )
        .await,
        "cadeia em fundo nao gravou o cache"
    );
    let second = crate::server::with_gate_wait_block(
        false,
        profile.resolve_gate_with(&url, &post, Arc::clone(&t), &cfg()),
    )
    .await;
    assert!(
        second.unwrap().contains("btih:0123456789abcdef"),
        "magnet veio do cache"
    );
    assert_eq!(
        runs.load(Ordering::SeqCst),
        1,
        "cache: nao reexecutou a cadeia"
    );
}

/// (c) wait=1 (modo bloqueante): espera a cadeia e devolve o magnet — o
/// contrato que o raspador em fundo vai usar.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_bloqueia_e_devolve_magnet() {
    let profile = profile();
    let (t, runs) = ModeTransport::build(Scenario::Ok);
    let url = gate_url("61003");
    let post = post_url();
    let magnet = crate::server::with_gate_wait_block(
        true,
        profile.resolve_gate_with(&url, &post, Arc::clone(&t), &cfg()),
    )
    .await
    .unwrap();
    assert!(magnet.contains("btih:0123456789abcdef"));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

/// (d) Falha da cadeia em fundo NAO envenena o cache: a proxima chamada
/// re-dispara (regra existente do fluxo, agora no modo kick).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn falha_da_cadeia_nao_envenena_cache_e_redispara() {
    let profile = profile();
    let (t, runs) = ModeTransport::build(Scenario::Fail);
    let url = gate_url("61004");
    let post = post_url();
    let first = crate::server::with_gate_wait_block(
        false,
        profile.resolve_gate_with(&url, &post, Arc::clone(&t), &cfg()),
    )
    .await;
    assert_eq!(first.unwrap_err(), GATE_PENDING);
    assert!(
        wait_until(|| runs.load(Ordering::SeqCst) == 1, Duration::from_secs(5)).await,
        "primeira cadeia em fundo nao rodou"
    );
    // Folga para a cadeia falhar, destruir a sessao e fechar o flight.
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(
        matches!(gate_flow::gate_cache_lookup(&url, &post), Ok(None)),
        "falha entrou no cache"
    );
    let second = crate::server::with_gate_wait_block(
        false,
        profile.resolve_gate_with(&url, &post, Arc::clone(&t), &cfg()),
    )
    .await;
    assert_eq!(
        second.unwrap_err(),
        GATE_PENDING,
        "chamada seguinte re-dispara (pendencia de novo)"
    );
    assert!(
        wait_until(|| runs.load(Ordering::SeqCst) == 2, Duration::from_secs(5)).await,
        "segunda cadeia nao foi disparada"
    );
}
