//! Testes HTTP da API administrativa do warmer RD (`/rd-warm*`).
//!
//! Módulo de `store_admin`: as rotas são montadas pelo MESMO
//! `router_with_ownership` (auth de loopback + token) num servidor axum real em
//! `127.0.0.1:0`. Os duplos são LOCAIS: nenhum teste aqui abre `cache.db`,
//! cofre ou rede — a sonda é uma porta falsa.

use std::sync::{Arc, Mutex};

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use adom_store::StreamsStore;

use super::{AdminConfig, DEFAULT_LISTEN};
use crate::rd_warmer::{
    LedgerMark, NoMagnet, RamQueue, WarmConfig, WarmDeps, WarmFuture, WarmKey, WarmLedger,
    WarmPort, WarmReport, WarmSignal, Warmer,
};

const TOKEN: &str = "token-diagnostico";
/// A credencial DESTRUTIVA (no boot real é a mesma env da superfície).
const DESTRUCTIVE: &str = "token-destrutivo";
const HASH: &str = "1111111111111111111111111111111111111111";
const SCOPE: &str = "realdebrid:conta";

fn payload() -> Value {
    json!({ "releases": [{ "title": "t", "infoHash": HASH, "isBr": true, "dubbed": true }] })
}

/// Chave fixa: o `enqueue` não consulta e o status só lê a ORIGEM.
struct FakeKey;

impl WarmKey for FakeKey {
    fn rd_key(&self, _scope: &str, _now_ms: i64) -> Option<String> {
        Some("chave-de-teste".to_string())
    }

    fn account_source(&self, _now_ms: i64) -> &'static str {
        "env"
    }
}

/// Porta que conta chamadas e devolve o veredito `attempted` + `Miss`.
#[derive(Default)]
struct FakePort {
    calls: Mutex<Vec<Vec<String>>>,
}

impl WarmPort for FakePort {
    fn warm<'a>(&'a self, _api_key: &'a str, hashes: &'a [String]) -> WarmFuture<'a> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(hashes.to_vec());
            let mut report = WarmReport::default();
            report.attempted = hashes.len();
            for hash in hashes {
                report.signals.push((hash.clone(), WarmSignal::Miss));
            }
            report
        })
    }
}

/// Ledger vazio: nada é conhecido antes da sonda.
#[derive(Default)]
struct FakeLedger;

impl WarmLedger for FakeLedger {
    fn state(&self, _hash: &str, _now_ms: i64) -> LedgerMark {
        LedgerMark::Other
    }

    fn note(&self, _hash: &str, _signal: WarmSignal, _now_ms: i64) {}
}

fn warmer_with(port: Arc<FakePort>) -> Arc<Warmer> {
    Warmer::with_deps(WarmDeps {
        config: WarmConfig::fixture(10, 100, 300),
        key: Arc::new(FakeKey),
        port,
        ledger: Arc::new(FakeLedger),
        magnet: Arc::new(NoMagnet),
        queue: Arc::new(RamQueue),
        traffic: None,
    })
}

fn warmer() -> Arc<Warmer> {
    warmer_with(Arc::new(FakePort::default()))
}

/// Sobe o roteador completo (auth + warmer) num socket efêmero.
async fn spawn(
    token: &str,
    destructive: Option<&str>,
    warm: Option<Arc<Warmer>>,
) -> std::net::SocketAddr {
    let cfg = AdminConfig {
        listen: DEFAULT_LISTEN.parse().unwrap(),
        token: token.to_string(),
        destructive_token: destructive.map(str::to_string),
    };
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let app = super::router_with_ownership(
        &cfg,
        store,
        300,
        None,
        None,
        None,
        crate::ownership_admin::router(),
        None,
        warm,
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

async fn call(addr: std::net::SocketAddr, req: Request<Body>) -> (StatusCode, Value) {
    let client = crate::proxy::client();
    let (mut parts, body) = req.into_parts();
    let pq = parts
        .uri
        .path_and_query()
        .map(|item| item.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    parts.uri = format!("http://{addr}{pq}").parse().unwrap();
    let response = client
        .request(Request::from_parts(parts, body))
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

fn get(path: &str, token: &str) -> Request<Body> {
    Request::builder()
        .uri(path)
        .header("x-indexer-test-token", token)
        .body(Body::empty())
        .unwrap()
}

fn post_json(path: &str, body: Value, token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header("x-indexer-test-token", token)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn status_sem_warmer_responde_desligado() {
    let addr = spawn(TOKEN, None, None).await;
    let (status, body) = call(addr, get("/rd-warm", TOKEN)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    assert_eq!(body["enabled"], false);
    assert_eq!(body["reason"], "disabled");
}

#[tokio::test]
async fn status_com_warmer_mostra_fila_quota_e_contadores() {
    let warm = warmer();
    assert_eq!(warm.enqueue(&payload(), SCOPE), 1);
    let addr = spawn(TOKEN, None, Some(warm)).await;

    let (status, body) = call(addr, get("/rd-warm", TOKEN)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    assert_eq!(body["enabled"], true, "{body}");
    assert_eq!(body["queueDepth"], 1);
    assert_eq!(body["queueMax"], 100);
    assert_eq!(body["batch"], 10);
    assert_eq!(body["maxPerHour"], 300);
    assert_eq!(body["queriesThisHour"], 0);
    assert_eq!(body["accountSource"], "env");
    assert_eq!(body["counters"]["enqueued"], 1);
    assert_eq!(body["counters"]["misses"], 0);
}

#[tokio::test]
async fn pause_e_resume_exigem_a_credencial_destrutiva() {
    // Sem a segunda credencial: 409 antes de olhar a fila.
    let addr = spawn(TOKEN, None, Some(warmer())).await;
    let (status, body) = call(addr, post_json("/rd-warm/pause", json!({}), TOKEN)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "rd_warm_requires_admin_token");

    // Token de diagnóstico no header não abre a rota destrutiva: 403.
    let addr = spawn(TOKEN, Some(DESTRUCTIVE), Some(warmer())).await;
    let (status, body) = call(addr, post_json("/rd-warm/pause", json!({}), TOKEN)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "rd_warm_token_insufficient");

    // Produção: a MESMA credencial abre a superfície e a rota destrutiva.
    let warm = warmer();
    let addr = spawn(DESTRUCTIVE, Some(DESTRUCTIVE), Some(warm.clone())).await;
    let (status, body) = call(addr, post_json("/rd-warm/pause", json!({}), DESTRUCTIVE)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["paused"], true);
    assert!(warm.is_paused());

    let (status, body) = call(addr, post_json("/rd-warm/resume", json!({}), DESTRUCTIVE)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["paused"], false);
    assert!(!warm.is_paused());
}

#[tokio::test]
async fn drain_exige_confirm_e_consome_a_fila() {
    let port = Arc::new(FakePort::default());
    let warm = warmer_with(port.clone());
    assert_eq!(warm.enqueue(&payload(), SCOPE), 1);
    let addr = spawn(DESTRUCTIVE, Some(DESTRUCTIVE), Some(warm.clone())).await;

    // Sem `confirm` a fila não é tocada.
    let (status, body) = call(addr, post_json("/rd-warm/drain", json!({}), DESTRUCTIVE)).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["error"], "confirmation_required");
    assert_eq!(warm.pending(), 1);

    let (status, body) = call(
        addr,
        post_json("/rd-warm/drain", json!({ "confirm": true }), DESTRUCTIVE),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["processed"], 1);
    assert_eq!(body["queueRemaining"], 0);
    assert_eq!(warm.pending(), 0);
    assert_eq!(warm.counters().misses, 1);
    assert_eq!(port.calls.lock().unwrap().len(), 1, "a sonda roda uma vez");

    // O status reflete o dreno: fila vazia e os contadores da sonda.
    let (status, body) = call(addr, get("/rd-warm", DESTRUCTIVE)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["queueDepth"], 0);
    assert_eq!(body["counters"]["probes"], 1);
    assert_eq!(body["counters"]["misses"], 1);
}
