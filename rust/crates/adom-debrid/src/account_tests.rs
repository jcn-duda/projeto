//! Servidor falso em 127.0.0.1 — sem rede real e sem imprimir a chave.
//!
//! Cada teste sobe o SEU servidor e aponta a base do adaptador para ele por
//! env. A trava [`crate::test_env::lock`] serializa os testes que tocam env
//! (a base é lida na construção do adaptador, mas `fetch_inventory` constrói o
//! adaptador por dentro).

use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::{
    fetch_inventory, is_known_service, label_of, supports_inventory, AccountInventory,
    InventoryItem, InventoryOpts,
};
use crate::verdict::UnusableKind;

struct Mock {
    status: u16,
    body: String,
    delay: Duration,
}

async fn respond(State(mock): State<std::sync::Arc<Mock>>) -> impl axum::response::IntoResponse {
    if !mock.delay.is_zero() {
        tokio::time::sleep(mock.delay).await;
    }
    (
        StatusCode::from_u16(mock.status).unwrap_or(StatusCode::OK),
        mock.body.clone(),
    )
}

async fn server(status: u16, body: &str) -> SocketAddr {
    server_with_delay(status, body, Duration::ZERO).await
}

async fn server_with_delay(status: u16, body: &str, delay: Duration) -> SocketAddr {
    let mock = std::sync::Arc::new(Mock {
        status,
        body: body.to_string(),
        delay,
    });
    let app = Router::new().fallback(any(respond)).with_state(mock);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

/// Aponta a base do serviço para o servidor falso durante a leitura. O guard
/// serializa os testes que tocam env (a base é lida DENTRO do `fetch`), por
/// isso fica preso ao await — de propósito, e só em teste.
#[allow(clippy::await_holding_lock)]
async fn with_base<T>(env_key: &str, addr: SocketAddr, fut: impl Future<Output = T>) -> T {
    let _lock = crate::test_env::lock();
    let prev = std::env::var(env_key).ok();
    unsafe {
        std::env::set_var(env_key, format!("http://{addr}"));
    }
    let out = fut.await;
    unsafe {
        match prev {
            Some(value) => std::env::set_var(env_key, value),
            None => std::env::remove_var(env_key),
        }
    }
    out
}

fn opts(max: usize) -> InventoryOpts {
    InventoryOpts {
        timeout: Duration::from_millis(500),
        max,
    }
}

async fn read(service: &str, env_key: &str, body: &str) -> AccountInventory {
    let addr = server(200, body).await;
    with_base(
        env_key,
        addr,
        fetch_inventory(service, "chave-de-teste", opts(3000)),
    )
    .await
    .expect("serviço conhecido")
}

fn hashes(inventory: &AccountInventory) -> Vec<&str> {
    inventory
        .items
        .iter()
        .map(|item| item.info_hash.as_str())
        .collect()
}

fn title<'a>(inventory: &'a AccountInventory, hash: &str) -> &'a InventoryItem {
    inventory
        .items
        .iter()
        .find(|item| item.info_hash == hash)
        .expect("item do hash")
}

#[test]
fn catalogo_de_servicos_do_inventario() {
    assert!(is_known_service("alldebrid"));
    assert!(supports_inventory("alldebrid"));
    assert!(supports_inventory("torbox"));
    assert!(supports_inventory("realdebrid"));
    assert!(supports_inventory("debridlink"));
    // Premiumize é conhecido, mas não tem inventário no TS.
    assert!(is_known_service("premiumize"));
    assert!(!supports_inventory("premiumize"));
    assert!(!is_known_service("magnetdb"));
    assert_eq!(label_of("alldebrid"), "AllDebrid");
    assert_eq!(label_of("realdebrid"), "Real-Debrid");
    assert_eq!(label_of("torbox"), "TorBox");
    assert_eq!(label_of("debridlink"), "Debrid-Link");
}

#[tokio::test]
async fn servico_sem_inventario_e_noop_conhecido() {
    let inventory = fetch_inventory("premiumize", "chave", opts(10))
        .await
        .expect("conhecido");
    assert!(inventory.known, "no-op é resposta, não 'não sei'");
    assert!(inventory.items.is_empty());
    assert!(!inventory.is_unusable());
}

#[tokio::test]
async fn servico_desconhecido_devolve_err() {
    assert!(fetch_inventory("servico-x", "chave", opts(10))
        .await
        .is_err());
}

#[tokio::test]
async fn alldebrid_inventario_vazio_e_conhecido() {
    let body = json!({
        "status": "success",
        "data": { "magnets": [
            { "id": 1, "hash": "AAA", "filename": "Baixando", "status": "Downloading", "size": 10 },
            { "id": 2, "hash": "BBB", "filename": "Na fila", "status": "Queued", "size": 10 },
        ]}
    })
    .to_string();
    let inventory = read("alldebrid", "ALLDEBRID_API_BASE", &body).await;
    assert!(inventory.known);
    assert!(inventory.items.is_empty(), "nada pronto = lista vazia");
    assert!(!inventory.is_unusable());
}

#[tokio::test]
async fn alldebrid_inventario_parcial_so_prontos() {
    let body = json!({
        "status": "success",
        "data": { "magnets": [
            // `ready` booleano.
            { "id": 1, "hash": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              "filename": "Filme Dublado 1080p", "ready": true, "size": 4_000_000_000i64 },
            // status Ready (case-insensitive), hash em caixa alta → lower.
            { "id": 2, "hash": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
              "filename": "Série Dual 720p", "status": "Ready", "size": 1_500_000_000i64 },
            // Ainda baixando.
            { "id": 3, "hash": "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
              "filename": "Filme Legendado", "status": "Downloading", "size": 1 },
            // Magnet sem metadado: filename É o hash.
            { "id": 4, "hash": "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
              "filename": "dddddddddddddddddddddddddddddddddddddddd", "ready": true, "size": 1 },
        ]}
    })
    .to_string();
    let inventory = read("alldebrid", "ALLDEBRID_API_BASE", &body).await;
    assert!(inventory.known);
    assert_eq!(
        hashes(&inventory),
        vec![
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        ]
    );
    let first = title(&inventory, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert_eq!(first.title, "Filme Dublado 1080p");
    assert_eq!(first.size, 4_000_000_000.0);
    assert_eq!(first.id, None, "AllDebrid não leva id no inventário do TS");
}

#[tokio::test]
async fn alldebrid_auth_vira_unusable() {
    let body = json!({
        "status": "error",
        "error": { "code": "AUTH_BAD_APIKEY", "message": "The API key is invalid" }
    })
    .to_string();
    let inventory = read("alldebrid", "ALLDEBRID_API_BASE", &body).await;
    assert!(!inventory.known);
    assert!(inventory.items.is_empty());
    match &inventory.unusable {
        Some((kind, message)) => {
            assert_eq!(*kind, UnusableKind::Auth);
            assert!(message.contains("invalid"));
        }
        None => panic!("auth deve marcar unusable"),
    }
}

#[tokio::test]
async fn alldebrid_quota_vira_unusable() {
    let body = json!({
        "status": "error",
        "error": { "code": "MAGNET_TOO_MANY_ACTIVE", "message": "Too many active magnets" }
    })
    .to_string();
    let inventory = read("alldebrid", "ALLDEBRID_API_BASE", &body).await;
    assert!(!inventory.known);
    assert_eq!(inventory.unusable.expect("quota").0, UnusableKind::Quota);
}

#[tokio::test]
async fn transiente_nao_e_unusable() {
    let addr = server(500, "{}").await;
    let inventory = with_base(
        "ALLDEBRID_API_BASE",
        addr,
        fetch_inventory("alldebrid", "chave", opts(3000)),
    )
    .await
    .expect("conhecido");
    assert!(!inventory.known, "HTTP 500 não prova nada");
    assert!(inventory.items.is_empty());
    assert!(
        !inventory.is_unusable(),
        "falha transitória NUNCA vira conta fora do ar"
    );
}

#[tokio::test]
async fn prazo_curto_nao_segura_e_nao_prova() {
    let addr = server_with_delay(200, "{}", Duration::from_millis(300)).await;
    let inventory = with_base(
        "ALLDEBRID_API_BASE",
        addr,
        fetch_inventory(
            "alldebrid",
            "chave",
            InventoryOpts {
                timeout: Duration::from_millis(20),
                max: 10,
            },
        ),
    )
    .await
    .expect("conhecido");
    assert!(!inventory.known);
    assert!(!inventory.is_unusable());
}

#[tokio::test]
async fn torbox_inventario_usa_download_present() {
    let body = json!({
        "success": true,
        "data": [
            { "hash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "name": "Filme Dublado",
              "download_finished": true, "size": 2_000_000_000i64 },
            { "hash": "ffffffffffffffffffffffffffffffffffffffff", "name": "Série Dual",
              "download_present": true, "size": 900_000_000i64 },
            { "hash": "9999999999999999999999999999999999999999", "name": "Baixando",
              "download_finished": false, "download_present": false, "size": 1 },
        ]
    })
    .to_string();
    let inventory = read("torbox", "TORBOX_API_BASE", &body).await;
    assert!(inventory.known);
    assert_eq!(
        hashes(&inventory),
        vec![
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "ffffffffffffffffffffffffffffffffffffffff"
        ]
    );
    assert_eq!(
        title(&inventory, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee").size,
        2_000_000_000.0
    );
}

#[tokio::test]
async fn realdebrid_inventario_so_downloaded_e_leva_id() {
    let body = json!([
        { "id": 7, "hash": "1111111111111111111111111111111111111111",
          "filename": "Filme Dublado 2160p", "status": "downloaded", "bytes": 8_000_000_000i64 },
        { "id": 8, "hash": "2222222222222222222222222222222222222222",
          "filename": "Baixando", "status": "downloading", "bytes": 1 },
        { "id": 9, "hash": "3333333333333333333333333333333333333333",
          "filename": "Legenda", "status": "error", "bytes": 1 }
    ])
    .to_string();
    let inventory = read("realdebrid", "REALDEBRID_API_BASE", &body).await;
    assert!(inventory.known);
    assert_eq!(
        hashes(&inventory),
        vec!["1111111111111111111111111111111111111111"]
    );
    assert_eq!(
        title(&inventory, "1111111111111111111111111111111111111111")
            .id
            .as_deref(),
        Some("7")
    );
}

#[tokio::test]
async fn debridlink_percentual_ausente_conta_como_pronto() {
    // A API embrulha a lista em `{success, value}` (o `value_of` do adaptador).
    let body = json!({
        "success": true,
        "value": [
            { "hash": "4444444444444444444444444444444444444444", "name": "Filme 1080p",
              "downloadPercent": 100, "totalSize": 3_000_000_000i64 },
            { "hash": "5555555555555555555555555555555555555555", "name": "Baixando",
              "downloadPercent": 42, "totalSize": 1 },
            // `Number(undefined) < 100` é falso no JS: linha sem percentual NÃO é
            // descartada. Reproduz o adaptador TS.
            { "infoHash": "6666666666666666666666666666666666666666", "name": "Sem percentual",
              "size": 700_000_000i64 }
        ]
    })
    .to_string();
    let inventory = read("debridlink", "DEBRIDLINK_API_BASE", &body).await;
    assert!(inventory.known);
    assert_eq!(
        hashes(&inventory),
        vec![
            "4444444444444444444444444444444444444444",
            "6666666666666666666666666666666666666666"
        ]
    );
    assert_eq!(
        title(&inventory, "6666666666666666666666666666666666666666").size,
        700_000_000.0,
        "totalSize ausente cai no size"
    );
}

#[tokio::test]
async fn teto_de_itens_respeita_o_max() {
    let rows: Vec<Value> = (0..5)
        .map(|n| {
            json!({
                "id": n,
                "hash": format!("{n:040x}"),
                "filename": format!("Filme {n}"),
                "ready": true,
                "size": 1_000_000_000i64,
            })
        })
        .collect();
    let body = json!({ "status": "success", "data": { "magnets": rows } }).to_string();
    let addr = server(200, &body).await;
    let inventory = with_base(
        "ALLDEBRID_API_BASE",
        addr,
        fetch_inventory("alldebrid", "chave", opts(2)),
    )
    .await
    .expect("conhecido");
    assert!(inventory.known);
    assert_eq!(inventory.items.len(), 2);
}
