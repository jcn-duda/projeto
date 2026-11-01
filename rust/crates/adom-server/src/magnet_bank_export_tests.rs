//! Testes do `GET /magnet-bank/export`. As guardas HTTP sobem o roteador
//! completo (mesma régua de `magnet_bank_admin_read_tests`, de onde vêm os
//! helpers e o LOCK de env — os dois módulos de teste tocam as MESMAS vars).
//! O formato do corpo é provado sem socket (`write_export` + banco em
//! memória) e uma vez por HTTP com banco vazio criado pelo env.

use http::StatusCode;
use serde_json::{json, Value};

use adom_store::MagnetBankStore;

use super::write_export;
use crate::magnet_bank_admin::read_tests::{
    env_lock, get_admin, get_admin_raw, two_magnets_file, EnvVar,
};
use crate::magnet_bank_admin::run_import;

const TOKEN: &str = "token-diagnostico";
const DESTRUCTIVE: &str = "token-destrutivo";
const ALPHA: &str = "2222222222222222222222222222222222222222";
const BETA: &str = "3333333333333333333333333333333333333333";

#[tokio::test]
async fn export_herdas_mesmas_guardas_do_status() {
    // Sem header nenhum: 401 do middleware, antes de qualquer guarda.
    let (status, value) = get_admin(TOKEN, Some(DESTRUCTIVE), None, "/magnet-bank/export").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(value["error"], "unauthorized", "{value}");
    // Token de diagnóstico não basta para ler o acervo inteiro.
    let (status, value) =
        get_admin(TOKEN, Some(DESTRUCTIVE), Some(TOKEN), "/magnet-bank/export").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(value["error"], "magnet_bank_token_insufficient", "{value}");
    // Sem credencial destrutiva configurada, nada a comparar.
    let (status, value) = get_admin(TOKEN, None, Some(TOKEN), "/magnet-bank/export").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(
        value["error"], "magnet_bank_requires_admin_token",
        "{value}"
    );
}

/// As duas recusas DEPOIS da credencial, com env serializado: kill-switch do
/// gateway (409, corta antes de abrir o banco) e store que não abre (500 —
/// nunca um 200 de acervo vazio fingido). O lock ATRAVESSA o `await` de
/// propósito: o handler lê o env DURANTE a requisição.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn export_recusa_kill_switch_e_store_que_nao_abre() {
    let _lock = env_lock();
    let _off = EnvVar::set("MAGNET_BANK", "false");
    let (status, value) = get_admin(
        DESTRUCTIVE,
        Some(DESTRUCTIVE),
        Some(DESTRUCTIVE),
        "/magnet-bank/export",
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{value}");
    assert_eq!(value["error"], "magnet_bank_disabled", "{value}");
    // Um DIRETÓRIO não abre como SQLite: `from_env` falha e vira 500.
    let dir = tempfile::tempdir().unwrap();
    let _path = EnvVar::set("MAGNET_BANK_DB_PATH", dir.path().to_str().unwrap());
    let _on = EnvVar::set("MAGNET_BANK", "true");
    let (status, value) = get_admin(
        DESTRUCTIVE,
        Some(DESTRUCTIVE),
        Some(DESTRUCTIVE),
        "/magnet-bank/export",
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{value}");
    assert_eq!(value["ok"], json!(false), "{value}");
}

/// O corpo do export é o MESMO NDJSON do transfer do TS: meta primeiro, um
/// registro por magnet com as SUAS fontes/obras (aqui, nenhum), cada linha um
/// JSON. Banco em memória + dreno do canal, sem socket nem env.
#[test]
fn write_export_monta_o_transfer_do_ts() {
    let store = MagnetBankStore::open_memory().unwrap();
    let file = two_magnets_file();
    assert_eq!(run_import(&store, file.path()).unwrap()["ok"], json!(true));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, String>>(16);
    let worker = std::thread::spawn(move || write_export(store, tx).unwrap());
    let mut body = Vec::new();
    while let Some(chunk) = rx.blocking_recv() {
        body.extend_from_slice(&chunk.unwrap());
    }
    // O contrato do `export_ndjson_into` é em LINHAS: meta + um por registro.
    assert_eq!(worker.join().unwrap(), 3);
    let lines: Vec<Value> = body
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 3, "{lines:?}");
    let meta = &lines[0];
    assert_eq!(meta["t"], json!("meta"), "{meta}");
    assert_eq!(meta["format"], json!("adom-magnet-bank"), "{meta}");
    assert_eq!(meta["engine"], json!("sql"), "{meta}");
    assert_eq!(meta["counts"]["magnets"], json!(2), "{meta}");
    for hash in [ALPHA, BETA] {
        assert!(
            lines
                .iter()
                .any(|line| line["t"] == json!("m") && line["hash"] == json!(hash)),
            "falta o magnet {hash}: {lines:?}"
        );
    }
}

/// Caminho HTTP inteiro (streaming): 200, content-type NDJSON e corpo
/// começando no cabeçalho do formato — banco vazio recém-criado pelo env.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn get_export_200_com_banco_vazio_por_env() {
    let _lock = env_lock();
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("magnets.db");
    let _path = EnvVar::set("MAGNET_BANK_DB_PATH", db.to_str().unwrap());
    let _on = EnvVar::set("MAGNET_BANK", "true");
    let (status, bytes, content_type) = get_admin_raw(
        DESTRUCTIVE,
        Some(DESTRUCTIVE),
        Some(DESTRUCTIVE),
        "/magnet-bank/export",
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&bytes)
    );
    assert_eq!(content_type.as_deref(), Some("application/x-ndjson"));
    let meta: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(meta["t"], json!("meta"), "{meta}");
    assert_eq!(meta["counts"]["magnets"], json!(0), "{meta}");
}
