//! Testes da rota `POST /magnet-bank/import` e das guardas puras.
//!
//! Módulo de `magnet_bank_admin`. Os testes HTTP sobem o roteador completo
//! (`router_with_ownership`) num socket efêmero, e só os casos de recusa
//! (409/403) — nenhum deles chega a abrir `magnets.db`.

use std::io::Write;
use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use adom_store::{MagnetBankStore, StreamsStore};

use super::{acquire, run_import, valid_spool_path};
use crate::store_admin::{AdminConfig, DEFAULT_LISTEN};

const TOKEN: &str = "token-diagnostico";
const DESTRUCTIVE: &str = "token-destrutivo";
const HASH: &str = "1111111111111111111111111111111111111111";

/// Cabeçalho do formato de transferência (`adom-magnet-bank`, v1) + 1 magnet.
fn one_magnet_file() -> tempfile::NamedTempFile {
    let mut file = tempfile::Builder::new()
        .prefix("adom-magnets-import-")
        .suffix(".ndjson")
        .tempfile_in(std::env::temp_dir())
        .unwrap();
    writeln!(file, r#"{{"t":"meta","format":"adom-magnet-bank","v":1}}"#).unwrap();
    writeln!(
        file,
        r#"{{"t":"m","hash":"{HASH}","title":"Teste","uri":"magnet:?xt=urn:btih:{HASH}"}}"#
    )
    .unwrap();
    file
}

#[test]
fn caminho_absoluto_com_nome_de_spool_passa() {
    let path = std::env::temp_dir().join("adom-magnets-import-1-2.ndjson");
    assert!(valid_spool_path(&path.to_string_lossy()).is_some());
}

#[test]
fn caminho_relativo_nome_errado_ou_extensao_errada_sao_recusados() {
    let temp = std::env::temp_dir();
    // Relativo: o gateway resolveria contra o próprio cwd.
    assert!(valid_spool_path("adom-magnets-import-1-2.ndjson").is_none());
    // `..` escapa do diretório do spool mesmo com o nome certo.
    let escape = temp.join("..").join("adom-magnets-import-1-2.ndjson");
    assert!(valid_spool_path(&escape.to_string_lossy()).is_none());
    // Nome que não é spool.
    assert!(valid_spool_path(&temp.join("outro.ndjson").to_string_lossy()).is_none());
    // Extensão `.upload`: é o nome que o Node grava hoje, e a rota o recusa.
    let upload = temp.join("adom-magnets-import-1-2.upload");
    assert!(valid_spool_path(&upload.to_string_lossy()).is_none());
}

#[test]
fn importacao_de_um_magnet_devolve_ok_e_insere() {
    let store = MagnetBankStore::open_memory().unwrap();
    let file = one_magnet_file();
    let value = run_import(&store, file.path()).unwrap();
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["magnets"]["inserted"], json!(1), "{value}");
    assert!(value["backfilled"].is_u64(), "{value}");
}

#[test]
fn arquivo_sem_cabecalho_devolve_ok_falso() {
    let store = MagnetBankStore::open_memory().unwrap();
    let mut file = tempfile::Builder::new()
        .prefix("adom-magnets-import-")
        .suffix(".ndjson")
        .tempfile_in(std::env::temp_dir())
        .unwrap();
    writeln!(file, r#"{{"t":"m","hash":"{HASH}"}}"#).unwrap();
    let value = run_import(&store, file.path()).unwrap();
    assert_eq!(value["ok"], json!(false), "{value}");
    assert_eq!(value["backfilled"], json!(0), "{value}");
}

#[test]
fn trava_de_ocupacao_libera_ao_sair_do_escopo() {
    let first = acquire();
    assert!(first.is_some());
    assert!(acquire().is_none(), "segunda importação deve ser recusada");
    drop(first);
    assert!(acquire().is_some(), "guard solto tem que liberar a trava");
}

/// Sobe o roteador completo num socket efêmero e devolve status + corpo JSON.
/// `surface` é o token que o middleware de autenticação aceita (o da superfície);
/// `header` é o que o cliente manda. Para a credencial destrutiva chegar ao handler,
/// o cliente tem que mandar o mesmo valor que abre a superfície.
async fn post_import(
    surface: &str,
    destructive: Option<&str>,
    header: &str,
    body: &str,
) -> (StatusCode, Value) {
    let cfg = AdminConfig {
        listen: DEFAULT_LISTEN.parse().unwrap(),
        token: surface.to_string(),
        destructive_token: destructive.map(str::to_string),
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
    let req = Request::builder()
        .method("POST")
        .uri(format!("http://{addr}/magnet-bank/import"))
        .header("x-indexer-test-token", header)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let response = crate::proxy::client().request(req).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn sem_credencial_destrutiva_responde_409() {
    let body = r#"{"path":"/x/adom-magnets-import-1.ndjson","confirm":true}"#;
    let (status, value) = post_import(TOKEN, None, TOKEN, body).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        value["error"], "magnet_bank_requires_admin_token",
        "{value}"
    );
}

#[tokio::test]
async fn token_de_diagnostico_nao_basta_responde_403() {
    let body = r#"{"path":"/x/adom-magnets-import-1.ndjson","confirm":true}"#;
    let (status, value) = post_import(TOKEN, Some(DESTRUCTIVE), TOKEN, body).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(value["error"], "magnet_bank_token_insufficient", "{value}");
}

#[tokio::test]
async fn sem_confirm_responde_409() {
    let body = r#"{"path":"/x/adom-magnets-import-1.ndjson"}"#;
    let (status, value) = post_import(DESTRUCTIVE, Some(DESTRUCTIVE), DESTRUCTIVE, body).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(value["error"], "confirmation_required", "{value}");
}
