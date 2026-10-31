//! Testes HTTP da rota `GET /debrid/inventory` — mesmo padrão dos
//! `rd_warmer_admin_tests` (router completo + token + chamada real em
//! loopback). O inventário GLOBAL é aquecido contra um servidor FAKE da
//! AllDebrid (`ALLDEBRID_API_BASE` em 127.0.0.1, o mesmo seam dos testes de
//! conta do `adom-debrid`): nenhum teste aqui fala com a rede de verdade.
//!
//! O global (`OnceLock`) sobrevive ao processo de teste inteiro — por isso
//! cada conta usa a própria chave (escopos diferentes não compartilham
//! snapshot) e quem toca env fica preso ao lock do arquivo.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use axum::body::Body;
use axum::Json;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use adom_debrid::alldebrid::AllDebrid;
use adom_debrid::alldebrid_cleanup::{account_scope, inventory};
use adom_debrid::http::HttpClient;
use adom_store::StreamsStore;

use crate::store_admin::{AdminConfig, DEFAULT_LISTEN};

const TOKEN: &str = "token-inventario";
/// Chave por teste: o handler deriva o escopo da MESMA env, e contas
/// distintas não compartilham snapshot no global.
const KEY_QUENTE: &str = "chave-teste-inventario-quente";
const KEY_FRIA: &str = "chave-teste-inventario-fria";
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Trava ÚNICA dos testes que tocam env: o handler lê
/// `DEBRID_SERVICE`/`DEBRID_API_KEY` a cada chamada e o cargo roda testes em
/// paralelo — env suja de um teste não pode virar resposta do outro.
fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

/// Guarda o valor anterior e devolve o restaurador — o padrão do
/// `with_base` de `account_tests` (adom-debrid): nenhum teste deixa env suja
/// para o vizinho, nem quando o assert falha.
fn env_guard(key: &'static str) -> Box<dyn FnOnce() -> String + '_> {
    let prev = std::env::var(key).ok();
    Box::new(move || {
        match prev {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
        key.to_string()
    })
}

/// Servidor FAKE da AllDebrid: `/magnet/status` com dois magnets (o contrato
/// que `magnet_hashes` lê: `data.magnets[].hash`).
async fn spawn_fake_alldebrid() -> SocketAddr {
    let magnets = json!({
        "status": "success",
        "data": { "magnets": [ { "hash": HASH_A }, { "hash": HASH_B } ] },
    });
    let app = axum::Router::new().route(
        "/magnet/status",
        axum::routing::get(move || {
            let body = magnets.clone();
            async move { Json(body) }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

/// Sobe o roteador completo (auth + a rota nova) num socket efêmero.
async fn spawn_admin(token: &str) -> SocketAddr {
    let cfg = AdminConfig {
        listen: DEFAULT_LISTEN.parse().unwrap(),
        token: token.to_string(),
        destructive_token: None,
    };
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let app = crate::store_admin::router_with_ownership(
        &cfg,
        store,
        300,
        None,
        None,
        None,
        crate::ownership_admin::router(),
        None,
        None,
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

async fn get_inventory(addr: SocketAddr, token: &str) -> (StatusCode, Value) {
    let response = crate::proxy::client()
        .request(
            Request::builder()
                .uri(format!("http://{addr}/debrid/inventory"))
                .header("x-indexer-test-token", token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn sem_conta_do_operador_responde_desligado_sem_zero() {
    let _env = env_lock();
    let _g1 = env_guard("DEBRID_SERVICE");
    let _g2 = env_guard("DEBRID_API_KEY");
    std::env::remove_var("DEBRID_SERVICE");
    std::env::remove_var("DEBRID_API_KEY");

    let addr = spawn_admin(TOKEN).await;
    let (status, body) = get_inventory(addr, TOKEN).await;
    drop(_g1);
    drop(_g2);

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true, "{body}");
    assert_eq!(body["enabled"], false, "{body}");
    assert_eq!(body["reason"], "no_operator_account", "{body}");
    assert!(body["count"].is_null(), "sem conta não há contagem: {body}");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn com_inventario_quente_mostra_a_contagem_da_conta() {
    let _env = env_lock();
    let _g1 = env_guard("ALLDEBRID_API_BASE");
    let _g2 = env_guard("DEBRID_SERVICE");
    let _g3 = env_guard("DEBRID_API_KEY");
    let addr_fake = spawn_fake_alldebrid().await;
    std::env::set_var("ALLDEBRID_API_BASE", format!("http://{addr_fake}"));
    std::env::set_var("DEBRID_SERVICE", "alldebrid");
    std::env::set_var("DEBRID_API_KEY", KEY_QUENTE);

    // Aquece o GLOBAL pelo caminho de produção (`load_now` é o mesmo do
    // `NativeInventory` das varreduras e do refresh em fundo da checagem).
    let ad = AllDebrid::new(HttpClient::new().expect("cliente http de teste"));
    let scope = account_scope(KEY_QUENTE);
    let snapshot = inventory()
        .load_now(&ad, KEY_QUENTE, &scope, None)
        .await
        .expect("o fake respondeu e o snapshot ficou quente");
    assert_eq!(snapshot.len(), 2, "o fake entregou dois hashes");

    let addr = spawn_admin(TOKEN).await;
    let (status, body) = get_inventory(addr, TOKEN).await;
    drop(_g1);
    drop(_g2);
    drop(_g3);

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true, "{body}");
    assert_eq!(body["enabled"], true, "{body}");
    assert!(body["reason"].is_null(), "{body}");
    assert_eq!(body["count"], 2, "a contagem é do peek do global: {body}");
    let at = body["at"].as_i64().unwrap_or(0);
    assert!(at > 0, "a foto carrega o relógio do gateway: {body}");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn com_conta_e_inventario_frio_count_e_null() {
    let _env = env_lock();
    let _g1 = env_guard("DEBRID_SERVICE");
    let _g2 = env_guard("DEBRID_API_KEY");
    std::env::set_var("DEBRID_SERVICE", "alldebrid");
    std::env::set_var("DEBRID_API_KEY", KEY_FRIA);

    let addr = spawn_admin(TOKEN).await;
    let (status, body) = get_inventory(addr, TOKEN).await;
    drop(_g1);
    drop(_g2);

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true, "{body}");
    assert_eq!(body["enabled"], true, "{body}");
    assert!(body["count"].is_null(), "frio é 'não sei', nunca 0: {body}");
}
