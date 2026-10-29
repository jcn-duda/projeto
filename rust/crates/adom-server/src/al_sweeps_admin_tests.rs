//! Testes das rotas admin das varreduras (`GET /sweeps`, `POST /sweeps/run`).
//!
//! Filho de `al_sweeps_tests` (reusa linhas e duplos). O roteador é o MESMO do
//! `store_admin` — a autenticação vem do middleware de lá, não se recria aqui.

use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

use adom_debrid::alldebrid_sweeps::SweepMode;
use adom_store::StreamsStore;

use crate::al_sweeps::{SweepAdmin, Sweeper};

use super::{dead_row, ready_row, source, sweeper, tweak, FakeFacts, INTERVAL, NOW};

const TOKEN: &str = "token-de-teste";

fn admin(
    mode: SweepMode,
    sweeper: Option<Arc<Sweeper>>,
    reason: Option<&'static str>,
) -> SweepAdmin {
    SweepAdmin {
        mode,
        interval_ms: INTERVAL,
        enabled: sweeper.is_some(),
        scheduled: sweeper.is_some(),
        disabled_reason: reason,
        sweeper,
        started_at_ms: NOW,
    }
}

/// O roteador REAL da admin, com o runtime injetado (ou `None`).
async fn serve(sweeps: Option<SweepAdmin>) -> std::net::SocketAddr {
    let cfg = crate::store_admin::AdminConfig {
        listen: crate::store_admin::DEFAULT_LISTEN.parse().unwrap(),
        token: TOKEN.to_string(),
    };
    let store = Arc::new(StreamsStore::open_memory_with_quota(8).unwrap());
    let app = crate::store_admin::router_with_ownership(
        &cfg,
        store,
        300,
        None,
        None,
        sweeps,
        crate::ownership_admin::router(),
        None,
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

async fn post(addr: std::net::SocketAddr, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method("POST")
        .uri("/sweeps/run")
        .header("x-indexer-test-token", TOKEN)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    call(addr, req).await
}

async fn status(addr: std::net::SocketAddr) -> (StatusCode, Value) {
    let req = Request::builder()
        .uri("/sweeps")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap();
    call(addr, req).await
}

#[tokio::test]
async fn status_tem_o_shape_do_contrato_mesmo_desligado() {
    let addr = serve(Some(admin(
        SweepMode::ReadOnly,
        None,
        Some("no_operator_account"),
    )))
    .await;
    let (code, body) = status(addr).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    assert_eq!(body["enabled"], false);
    assert_eq!(body["scheduled"], false);
    assert_eq!(body["mode"], "read_only", "modo efetivo, não o pedido");
    assert_eq!(body["intervalMs"], INTERVAL);
    assert_eq!(body["running"], false);
    assert_eq!(body["disabledReason"], "no_operator_account");
    assert_eq!(body["lastTickAt"], Value::Null);
    assert_eq!(body["nextDueAt"], Value::Null);
    assert_eq!(body["last"], Value::Null);
    assert_eq!(body["counters"]["runs"], 0);
    assert_eq!(body["counters"]["sweptUndubbed"], 0);
    for kind in ["sweepDead", "sweepUndubbed", "reconcile", "revalidate"] {
        assert_eq!(body["counters"]["byKind"][kind]["runs"], 0, "{kind}");
    }
    assert!(body["counters"]["reasons"].is_object());
}

#[tokio::test]
async fn status_sem_runtime_responde_not_wired_sem_500() {
    let addr = serve(None).await;
    let (code, body) = status(addr).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    assert_eq!(body["enabled"], false);
    assert_eq!(body["mode"], "off");
    assert_eq!(body["disabledReason"], "not_wired");
}

#[tokio::test]
async fn post_rejeita_kind_invalido_e_credencial_no_corpo() {
    let addr = serve(Some(admin(SweepMode::ReadOnly, None, Some("cleanup_off")))).await;
    for body in [
        json!({}),
        json!({ "kind": "all" }),
        json!({ "kind": "dead" }),
        json!({ "kind": 7 }),
    ] {
        let (code, out) = post(addr, body.clone()).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{body} => {out}");
        assert_eq!(out["error"], "invalid_kind", "{body}");
    }
    // Credencial/escopo no corpo: a conta é SEMPRE a do operador.
    for field in ["apiKey", "encoded", "service", "accountScope"] {
        let mut body = serde_json::Map::new();
        body.insert("kind".into(), json!("sweepDead"));
        body.insert(field.to_string(), json!("x"));
        let (code, out) = post(addr, Value::Object(body)).await;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{field} => {out}");
        assert_eq!(out["error"], "operator_only", "{field}");
    }
}

#[tokio::test]
async fn post_sem_runtime_e_desligado_publicam_o_motivo() {
    let sem_runtime = serve(None).await;
    let (code, out) = post(sem_runtime, json!({ "kind": "sweepDead" })).await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE, "{out}");
    assert_eq!(out["error"], "sweeps_unavailable");
    assert_eq!(out["reason"], "not_wired");

    for reason in ["no_operator_account", "http_client_unavailable"] {
        let addr = serve(Some(admin(SweepMode::ReadOnly, None, Some(reason)))).await;
        let (code, out) = post(addr, json!({ "kind": "sweepDead" })).await;
        assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE, "{reason} => {out}");
        assert_eq!(out["reason"], reason);
    }
    for reason in ["cleanup_off", "interval_zero"] {
        let addr = serve(Some(admin(SweepMode::Off, None, Some(reason)))).await;
        let (code, out) = post(addr, json!({ "kind": "sweepDead" })).await;
        assert_eq!(code, StatusCode::CONFLICT, "{reason} => {out}");
        assert_eq!(out["error"], "sweeps_disabled");
        assert_eq!(out["reason"], reason);
    }
}

#[tokio::test]
async fn post_apply_exige_confirmacao_antes_de_listar_a_conta() {
    let source = source(Some(vec![dead_row('a'), ready_row('b')]));
    let sweeper = sweeper(
        SweepMode::Apply,
        source.clone(),
        FakeFacts::loaded(&[]).owns('b'),
    );
    let addr = serve(Some(admin(SweepMode::Apply, Some(sweeper), None))).await;
    let (code, out) = post(addr, json!({ "kind": "sweepDead" })).await;
    assert_eq!(code, StatusCode::CONFLICT, "{out}");
    assert_eq!(out["error"], "confirmation_required");
    assert_eq!(source.rows_calls(), 0, "confirmação vem antes do I/O");

    let (code, out) = post(addr, json!({ "kind": "sweepDead", "confirm": true })).await;
    assert_eq!(code, StatusCode::OK, "{out}");
    assert_eq!(out["applied"], true);
    assert_eq!(out["mode"], "apply");
    assert_eq!(out["swept"], 1);
    assert_eq!(source.deletes(), vec!["id-a"]);
}

#[tokio::test]
async fn post_readonly_200_com_o_corpo_do_contrato() {
    let source = source(Some(vec![dead_row('a'), ready_row('b')]));
    let sweeper = sweeper(
        SweepMode::ReadOnly,
        source.clone(),
        FakeFacts::loaded(&[]).owns('b'),
    );
    let addr = serve(Some(admin(SweepMode::ReadOnly, Some(sweeper), None))).await;
    let (code, out) = post(addr, json!({ "kind": "sweepDead" })).await;
    assert_eq!(code, StatusCode::OK, "{out}");
    assert_eq!(out["ok"], true);
    assert_eq!(out["kind"], "sweepDead");
    assert_eq!(out["ran"], true);
    assert_eq!(out["mode"], "read_only");
    assert_eq!(out["applied"], false);
    assert_eq!(out["planned"], 1);
    assert_eq!(out["swept"], 0);
    assert_eq!(out["varridos"], 0);
    assert_eq!(out["falhas"], 0);
    assert_eq!(out["calls"], 0);
    assert_eq!(out["missing"], false);
    assert_eq!(out["reasons"]["ready"], 1);
    assert!(out["at"].as_i64().unwrap() > 0);
    assert!(source.deletes().is_empty(), "ReadOnly não apaga");
}

#[tokio::test]
async fn post_concorrente_um_executa_o_outro_recebe_409() {
    let gate = Arc::new(Semaphore::new(0));
    let source = tweak(source(Some(vec![ready_row('b')])), |s| {
        s.gate(gate.clone());
    });
    let sweeper = sweeper(SweepMode::ReadOnly, source.clone(), FakeFacts::loaded(&[]));
    let addr = serve(Some(admin(SweepMode::ReadOnly, Some(sweeper), None))).await;
    let first = tokio::spawn(async move { post(addr, json!({ "kind": "sweepDead" })).await });
    while source.rows_calls() == 0 {
        tokio::task::yield_now().await;
    }
    let (code, out) = post(addr, json!({ "kind": "sweepUndubbed" })).await;
    assert_eq!(code, StatusCode::CONFLICT, "{out}");
    assert_eq!(out["error"], "sweep_in_progress");
    assert_eq!(out["reason"], "reentered");
    assert_eq!(out["running"], true);
    gate.add_permits(1);
    let (code, out) = first.await.unwrap();
    assert_eq!(code, StatusCode::OK, "{out}");
    assert_eq!(source.rows_calls(), 1, "o 409 não listou a conta de novo");

    let (_, body) = status(addr).await;
    assert_eq!(body["counters"]["reentered"], 1);
    assert_eq!(body["counters"]["manualRuns"], 1);
}

#[tokio::test]
async fn status_nao_vaza_hash_id_nem_credencial() {
    let source = source(Some(vec![dead_row('a')]));
    let sweeper = sweeper(SweepMode::ReadOnly, source.clone(), FakeFacts::loaded(&[]));
    let addr = serve(Some(admin(SweepMode::ReadOnly, Some(sweeper), None))).await;
    let _ = post(addr, json!({ "kind": "sweepDead" })).await;
    let (code, body) = status(addr).await;
    assert_eq!(code, StatusCode::OK, "{body}");
    assert_eq!(body["counters"]["runs"], 1);
    assert_eq!(body["last"]["outcomes"][0]["kind"], "sweepDead");
    let raw = body.to_string();
    for secret in [super::hash_of('a'), "id-a".to_string(), "apiKey".into()] {
        assert!(!raw.contains(&secret), "{secret} vazou: {raw}");
    }
}
