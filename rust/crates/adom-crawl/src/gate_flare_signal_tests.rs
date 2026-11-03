//! Testes da ponte do sinal EXTERNO de flare (`gate/flare_signal.rs`): a
//! admin falsa (axum, porta efêmera — reusa o bind do suporte) serve
//! `/flare/busy` e o teste prova o OR da rodada (local OU externo), o
//! fail-open (admin morta, rota ausente, corpo estranho, token errado) e o
//! cache curto que evita martelar a admin a cada decisão.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::json;

use super::flare_signal::{token_from_lookup, ExternalFlareSignal, TOKEN_HEADER};
use super::support::*;
use super::*;

/// Admin falsa com credencial: `/flare/busy` responde `{"busy": <busy>}` só
/// com o token esperado (401 caso contrário — a recusa nem conta como
/// consulta) e CONTA as consultas bem-sucedidas: o contador é o que prova o
/// cache.
async fn admin_falsa(busy: bool, token: &'static str, consultas: Arc<AtomicUsize>) -> Router {
    Router::new().route(
        "/flare/busy",
        get(move |headers: HeaderMap| async move {
            let got = headers
                .get(TOKEN_HEADER)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if got != token {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "ok": false, "error": "unauthorized" })),
                );
            }
            consultas.fetch_add(1, Ordering::SeqCst);
            (StatusCode::OK, Json(json!({ "busy": busy })))
        }),
    )
}

/// Sinal externo true/false: a ponte devolve o que a admin diz — e o token
/// certo vai no header (com token errado a admin falsa recusaria e viraria
/// fail-open).
#[tokio::test]
async fn sinal_externo_reflete_a_admin() {
    let consultas_ocupada = Arc::new(AtomicUsize::new(0));
    let ocupada =
        bind_node(admin_falsa(true, "token-de-teste", consultas_ocupada.clone()).await).await;
    let sinal = Arc::new(ExternalFlareSignal::new(
        &ocupada,
        "token-de-teste",
        250,
        60_000,
    ));
    assert!(sinal.busy().await, "admin diz ocupado");

    let consultas_livre = Arc::new(AtomicUsize::new(0));
    let livre =
        bind_node(admin_falsa(false, "token-de-teste", consultas_livre.clone()).await).await;
    let sinal_livre = Arc::new(ExternalFlareSignal::new(
        &livre,
        "token-de-teste",
        250,
        60_000,
    ));
    assert!(!sinal_livre.busy().await, "admin diz livre");

    assert_eq!(consultas_ocupada.load(Ordering::SeqCst), 1);
    assert_eq!(consultas_livre.load(Ordering::SeqCst), 1);
}

/// Fail-open: admin em porta fechada devolve false — erro NUNCA bloqueia o
/// portão (porta 1 no loopback recusa na hora, mesma artimanha dos testes do
/// executor).
#[tokio::test]
async fn admin_morta_e_fail_open() {
    let sinal = Arc::new(ExternalFlareSignal::new(
        "http://127.0.0.1:1",
        "token-de-teste",
        250,
        60_000,
    ));
    let inicio = std::time::Instant::now();
    assert!(!sinal.busy().await, "falha do sinal não segura a rodada");
    assert!(
        inicio.elapsed() < Duration::from_secs(5),
        "falha é rápida, não pendura a rodada"
    );
}

/// Rota ausente (gateway velho sem `/flare/busy`) e corpo que não é o
/// contrato: fail-open nas duas.
#[tokio::test]
async fn rota_ausente_e_corpo_estranho_sao_fail_open() {
    let sem_rota = bind_node(Router::new()).await;
    let sinal = Arc::new(ExternalFlareSignal::new(&sem_rota, "t", 250, 60_000));
    assert!(!sinal.busy().await, "404 não bloqueia o portão");

    let app = Router::new().route("/flare/busy", get(|| async { "<html>desafio</html>" }));
    let html = bind_node(app).await;
    let sinal = Arc::new(ExternalFlareSignal::new(&html, "t", 250, 60_000));
    assert!(!sinal.busy().await, "corpo estranho não bloqueia o portão");
}

/// Token fora de sintonia com a admin: 401 vira fail-open (nunca bloqueia o
/// portão por credencial) e a recusa nem entra no contador de consultas.
#[tokio::test]
async fn token_errado_e_fail_open() {
    let consultas = Arc::new(AtomicUsize::new(0));
    let base = bind_node(admin_falsa(true, "token-certo", consultas.clone()).await).await;
    let sinal = Arc::new(ExternalFlareSignal::new(&base, "token-errado", 250, 60_000));
    assert!(!sinal.busy().await, "401 não bloqueia o portão");
    assert_eq!(consultas.load(Ordering::SeqCst), 0, "recusa nem conta");
}

/// Cache curto: duas decisões dentro do TTL fazem UMA consulta; vencido o
/// TTL, a próxima decisão consulta de novo. O TTL pequeno é injetado pelo
/// construtor — em produção é a constante de 1,5 s.
#[tokio::test]
async fn cache_evita_martelar_a_admin() {
    let consultas = Arc::new(AtomicUsize::new(0));
    let base = bind_node(admin_falsa(true, "t", consultas.clone()).await).await;
    let sinal = Arc::new(ExternalFlareSignal::new(&base, "t", 250, 120));

    assert!(sinal.busy().await);
    assert!(sinal.busy().await, "segunda decisão vem do cache");
    assert_eq!(consultas.load(Ordering::SeqCst), 1, "uma consulta só");

    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(sinal.busy().await, "TTL vencido consulta de novo");
    assert_eq!(consultas.load(Ordering::SeqCst), 2);
}

/// OR da rodada: sinal externo ocupado (com a sonda LOCAL livre) pula a
/// rodada inteira — resolver não é tocado e a linha fica pendente.
#[tokio::test]
async fn sinal_externo_ocupado_pula_a_rodada() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);

    let consultas = Arc::new(AtomicUsize::new(0));
    let admin = bind_node(admin_falsa(true, "t", consultas.clone()).await).await;
    let chamadas = Arc::new(AtomicUsize::new(0));
    let mut ex = executor(
        &caminho,
        // Node morto: o skip do flare acontece ANTES do freio de tráfego.
        "http://127.0.0.1:1",
        plug(&IngestFake::novo(Recusa::Nunca)),
        falso(chamadas.clone(), false),
        Arc::new(FlareFake { ocupado: false }),
        4,
    );
    ex.flare_signal = Some(Arc::new(ExternalFlareSignal::new(&admin, "t", 250, 60_000)));

    let report = ex.run_round().await.expect("rodada");
    assert_eq!(
        report,
        GateRoundReport {
            claimed: 0,
            paid: 0,
            skipped: Some("flare-ocupado")
        }
    );
    assert_eq!(chamadas.load(Ordering::SeqCst), 0, "nada pago");
    assert_eq!(consultas.load(Ordering::SeqCst), 1, "sinal consultado");
    assert_eq!(ler_linha(&caminho, "post-1").0, "gate-pending");
}

/// Sinal externo livre NÃO segura a rodada: o pagamento segue (a sonda local
/// continua sendo o único bloqueio local).
#[tokio::test]
async fn sinal_externo_livre_nao_segura_a_rodada() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    semear_gate(&caminho, "post-1", GATE);

    let consultas = Arc::new(AtomicUsize::new(0));
    let admin = bind_node(admin_falsa(false, "t", consultas.clone()).await).await;
    let ingest = IngestFake::novo(Recusa::Nunca);
    let entregues = ingest.entregues.clone();
    let node = node_falso(false).await;
    let chamadas = Arc::new(AtomicUsize::new(0));
    let mut ex = executor(
        &caminho,
        &node,
        plug(&ingest),
        falso(chamadas.clone(), false),
        Arc::new(FlareFake { ocupado: false }),
        4,
    );
    ex.flare_signal = Some(Arc::new(ExternalFlareSignal::new(&admin, "t", 250, 60_000)));

    let report = ex.run_round().await.expect("rodada");
    assert_eq!(report.paid, 1, "sinal livre: pagamento segue");
    assert_eq!(chamadas.load(Ordering::SeqCst), 1);
    assert_eq!(consultas.load(Ordering::SeqCst), 1);
    assert_eq!(entregues.lock().unwrap().len(), 1, "release no acervo");
}

/// Fiação de produção: cfg SEM credencial não monta a ponte (e fica sem
/// rede); cfg COM credencial monta e usa a URL/token da config.
#[tokio::test]
async fn ponte_da_config_sem_token_nao_monta_e_com_token_monta() {
    let cfg = GateExecutorConfig::default();
    assert!(
        ExternalFlareSignal::from_config(&cfg).is_none(),
        "sem credencial não há ponte"
    );

    let consultas = Arc::new(AtomicUsize::new(0));
    let admin = bind_node(admin_falsa(true, "token-da-admin", consultas.clone()).await).await;
    let cfg = GateExecutorConfig {
        flare_admin_url: admin.clone(),
        flare_admin_token: "token-da-admin".to_string(),
        ..Default::default()
    };
    let sinal = ExternalFlareSignal::from_config(&cfg).expect("ponte montada");
    assert!(sinal.busy().await, "ponte usa a URL e o token da config");
    assert_eq!(consultas.load(Ordering::SeqCst), 1);
}

/// Cadeia do token: MESMA precedência do `store_admin` e da ponte de
/// invalidação — `STREAM_STORE_ADMIN_TOKEN` vence, vazio não vence, e a
/// ausência de todos devolve vazio (ponte inativa).
#[test]
fn cadeia_do_token_bate_com_a_admin() {
    let lookup = |key: &str| match key {
        "STREAM_STORE_ADMIN_TOKEN" => Some("proprio".to_string()),
        "DEBRID_INTERNAL_TOKEN" => Some("debrid".to_string()),
        "JACKETT_TEST_TOKEN" => Some("jackett".to_string()),
        _ => None,
    };
    assert_eq!(token_from_lookup(lookup), "proprio");

    // Vazio/branco não vence.
    let lookup = |key: &str| match key {
        "STREAM_STORE_ADMIN_TOKEN" => Some("   ".to_string()),
        "DEBRID_INTERNAL_TOKEN" => Some(String::new()),
        "JACKETT_TEST_TOKEN" => Some("jackett".to_string()),
        _ => None,
    };
    assert_eq!(token_from_lookup(lookup), "jackett");

    assert_eq!(token_from_lookup(|_| None), "", "sem nada: ponte inativa");
}
