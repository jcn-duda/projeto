//! Testes das rotas de LEITURA do banco de magnets (`GET /magnet-bank/status`
//! e `GET /magnet-bank/search`). Módulo de `magnet_bank_admin`, separado do
//! arquivo de testes do import para não disputar o teto de 400 linhas.
//!
//! As guardas HTTP sobem o roteador completo (`router_with_ownership`) num
//! socket efêmero e NUNCA abrem o banco; os shapes de 200 usam
//! `MagnetBankStore::open_memory()` no nível do payload (mesmo padrão do
//! `run_import`) e um caso sobe o caminho HTTP inteiro com o banco apontado
//! para um arquivo temporário (`MAGNET_BANK_DB_PATH`).

use std::io::Write;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use axum::body::Body;
use http::{header, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use adom_store::{MagnetBankStore, StreamsStore};

use super::{magnet_bank_enabled, run_import, search_limit, search_payload, status_payload};
use crate::store_admin::{AdminConfig, DEFAULT_LISTEN};

const TOKEN: &str = "token-diagnostico";
const DESTRUCTIVE: &str = "token-destrutivo";
const ALPHA: &str = "2222222222222222222222222222222222222222";
const BETA: &str = "3333333333333333333333333333333333333333";

/// Trava ÚNICA dos testes que tocam env — compartilhada com
/// `magnet_bank_export_tests` (mesmas vars): a var é do processo inteiro e os
/// testes do crate correm em threads paralelas.
pub(crate) static ENV_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn env_lock() -> MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Seta a var e restaura o valor anterior ao sair (padrão de
/// `dub_audit_writes_tests`): nada vaza para os testes irmãos.
pub(crate) struct EnvVar {
    key: &'static str,
    saved: Option<String>,
}

impl EnvVar {
    pub(crate) fn set(key: &'static str, value: &str) -> Self {
        let saved = std::env::var(key).ok();
        unsafe { std::env::set_var(key, value) };
        Self { key, saved }
    }
}

impl Drop for EnvVar {
    fn drop(&mut self) {
        unsafe {
            match self.saved.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }
}

/// GET no roteador completo num socket efêmero. `surface` é o token que o
/// middleware aceita; `destructive` é o que o handler compara; `header` é o
/// que o cliente manda (`None` = sem header, para o 401 do middleware).
/// Versão crua: devolve corpo e content-type (o export responde NDJSON).
pub(crate) async fn get_admin_raw(
    surface: &str,
    destructive: Option<&str>,
    header: Option<&str>,
    uri: &str,
) -> (StatusCode, Vec<u8>, Option<String>) {
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
    let mut builder = Request::builder()
        .method("GET")
        .uri(format!("http://{addr}{uri}"));
    if let Some(token) = header {
        builder = builder.header("x-indexer-test-token", token);
    }
    let req = builder.body(Body::empty()).unwrap();
    let response = crate::proxy::client().request(req).await.unwrap();
    let status = response.status();
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec(), content_type)
}

/// Mesma chamada com o corpo parseado como JSON (`unwrap_or(Null)`, porque
/// as rotas de guarda só falam JSON).
pub(crate) async fn get_admin(
    surface: &str,
    destructive: Option<&str>,
    header: Option<&str>,
    uri: &str,
) -> (StatusCode, Value) {
    let (status, bytes, _) = get_admin_raw(surface, destructive, header, uri).await;
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

// ---------------------------------------------------------------------------
// Guardas HTTP (nenhum teste aqui abre o banco)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn get_sem_token_responde_401() {
    let (status, value) = get_admin(TOKEN, Some(DESTRUCTIVE), None, "/magnet-bank/status").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value["error"], "unauthorized", "{value}");
}

#[tokio::test]
async fn get_com_token_de_diagnostico_responde_403() {
    let (status, value) =
        get_admin(TOKEN, Some(DESTRUCTIVE), Some(TOKEN), "/magnet-bank/status").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(value["error"], "magnet_bank_token_insufficient", "{value}");
}

#[tokio::test]
async fn get_sem_credencial_destrutiva_configurada_responde_409() {
    let (status, value) = get_admin(TOKEN, None, Some(TOKEN), "/magnet-bank/status").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        value["error"], "magnet_bank_requires_admin_token",
        "{value}"
    );
}

#[tokio::test]
async fn search_herdas_mesmas_guardas_do_status() {
    // Token fraco (diagnóstico) não basta na busca.
    let (status, value) = get_admin(
        TOKEN,
        Some(DESTRUCTIVE),
        Some(TOKEN),
        "/magnet-bank/search?q=x&limit=5",
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(value["error"], "magnet_bank_token_insufficient", "{value}");
    // Sem header nenhum é 401 do middleware.
    let (status, value) = get_admin(TOKEN, Some(DESTRUCTIVE), None, "/magnet-bank/search").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value["error"], "unauthorized", "{value}");
}

// ---------------------------------------------------------------------------
// Shape de 200 no nível do payload (banco em memória, sem env)
// ---------------------------------------------------------------------------

/// Spool com DOIS magnets de títulos distintos (busca por título e limite).
pub(crate) fn two_magnets_file() -> tempfile::NamedTempFile {
    let mut file = tempfile::Builder::new()
        .prefix("adom-magnets-import-")
        .suffix(".ndjson")
        .tempfile_in(std::env::temp_dir())
        .unwrap();
    writeln!(file, r#"{{"t":"meta","format":"adom-magnet-bank","v":1}}"#).unwrap();
    writeln!(
        file,
        r#"{{"t":"m","hash":"{ALPHA}","title":"Filme Alpha Dublado","uri":"magnet:?xt=urn:btih:{ALPHA}"}}"#
    )
    .unwrap();
    writeln!(
        file,
        r#"{{"t":"m","hash":"{BETA}","title":"Outro Beta","uri":"magnet:?xt=urn:btih:{BETA}"}}"#
    )
    .unwrap();
    file
}

#[test]
fn status_com_banco_vazio_tem_o_shape_do_painel() {
    let store = MagnetBankStore::open_memory().unwrap();
    // O `enabled` recebido é o que volta (o painel distingue desligado de vazio).
    let value = status_payload(&store, true).unwrap();
    for key in [
        "enabled",
        "engine",
        "magnets",
        "sources",
        "works",
        "lastSeen",
        "byIndexer",
        "memoryMax",
        "memoryEvictions",
        "queue",
        "queueMax",
    ] {
        assert!(value.get(key).is_some(), "faltou {key} no status: {value}");
    }
    assert_eq!(value["enabled"], json!(true), "{value}");
    assert_eq!(value["magnets"], json!(0), "{value}");
    assert!(value["byIndexer"].is_array(), "{value}");
    let value = status_payload(&store, false).unwrap();
    assert_eq!(value["enabled"], json!(false), "{value}");
}

#[test]
fn search_com_banco_vazio_devolve_recentes_vazios() {
    let store = MagnetBankStore::open_memory().unwrap();
    let value = search_payload(&store, "", 50).unwrap();
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["mode"], json!("recent"), "{value}");
    assert_eq!(value["returned"], json!(0), "{value}");
    assert_eq!(value["items"], json!([]), "{value}");
}

#[test]
fn search_por_titulo_casa_e_limit_corta() {
    let store = MagnetBankStore::open_memory().unwrap();
    let file = two_magnets_file();
    let report = run_import(&store, file.path()).unwrap();
    assert_eq!(report["ok"], json!(true), "{report}");
    // Por título: só o Alpha.
    let value = search_payload(&store, "Alpha", 50).unwrap();
    assert_eq!(value["ok"], json!(true), "{value}");
    assert_eq!(value["returned"], json!(1), "{value}");
    assert_eq!(value["items"][0]["hash"], json!(ALPHA), "{value}");
    // Recentes com limite 1: uma linha, janela cortada (janela `limit + 1`).
    let value = search_payload(&store, "", 1).unwrap();
    assert_eq!(value["returned"], json!(1), "{value}");
    assert_eq!(value["truncated"], json!(true), "{value}");
}

#[test]
fn limit_da_rota_segue_o_clamp_do_painel() {
    // Ausente/inválido/<=0 → default 50; acima do teto → 100.
    assert_eq!(search_limit(None), 50);
    assert_eq!(search_limit(Some("abc")), 50);
    assert_eq!(search_limit(Some("0")), 50);
    assert_eq!(search_limit(Some("-5")), 50);
    assert_eq!(search_limit(Some("10")), 10);
    assert_eq!(search_limit(Some("1000")), 100);
}

// ---------------------------------------------------------------------------
// Kill-switch (env serializado) e caminho HTTP completo
// ---------------------------------------------------------------------------

#[test]
fn kill_switch_so_o_literal_false_desliga() {
    let _lock = env_lock();
    let off = EnvVar::set("MAGNET_BANK", "false");
    assert!(!magnet_bank_enabled());
    drop(off);
    let other = EnvVar::set("MAGNET_BANK", "0");
    assert!(magnet_bank_enabled(), "só o literal false desliga");
    drop(other);
    let on = EnvVar::set("MAGNET_BANK", "true");
    assert!(magnet_bank_enabled());
    drop(on);
    // Ausente: ligado (default). O restore é manual porque a var sai do env.
    let saved = std::env::var("MAGNET_BANK").ok();
    unsafe { std::env::remove_var("MAGNET_BANK") };
    assert!(magnet_bank_enabled());
    if let Some(value) = saved {
        unsafe { std::env::set_var("MAGNET_BANK", value) };
    }
}

/// Caminho HTTP inteiro: env → rota → spawn_blocking → store em arquivo
/// temporário → 200 com o shape do painel (banco vazio recém-criado).
/// O `env_lock` PRECISA atravessar o `await`: o handler lê as vars do env
/// DURANTE a requisição. A trava é só coordenação entre testes, não entre
/// tarefas do runtime — nenhum outro await depende dela.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn get_status_200_com_banco_vazio_por_env() {
    let _lock = env_lock();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("magnets.db");
    let _path = EnvVar::set("MAGNET_BANK_DB_PATH", db.to_str().unwrap());
    let _on = EnvVar::set("MAGNET_BANK", "true");
    let (status, value) = get_admin(
        DESTRUCTIVE,
        Some(DESTRUCTIVE),
        Some(DESTRUCTIVE),
        "/magnet-bank/status",
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{value}");
    assert_eq!(value["magnets"], json!(0), "{value}");
    assert_eq!(value["enabled"], json!(true), "{value}");
    assert!(value["byIndexer"].is_array(), "{value}");
}
