//! Rotas administrativas do banco de magnets (`magnets.db`) e backfill no boot.
//!
//! Rotas (montadas por `store_admin::router_with_ownership`, então herdam o
//! token de diagnóstico da superfície):
//!
//! | rota | efeito |
//! |---|---|
//! | `POST /magnet-bank/import` `{"path":"<spool>","confirm":true}` | mescla um NDJSON no acervo vivo + backfill de classificação — DESTRUTIVA + `confirm` |
//!
//! Por que a importação é "destrutiva" se a mescla nunca apaga: ela GRAVA no
//! acervo permanente (URI, `is_br`, `lied` podem trocar de valor), e um arquivo
//! errado não tem como ser desfeito. Por isso exige a MESMA credencial do
//! `suppressed-drain` e o `confirm`, em vez do token de diagnóstico.
//!
//! O arquivo chega como spool que o Node grava em disco; a rota só lê caminho
//! que passa na guarda (`valid_spool_path`), para não virar leitor arbitrário.

use std::fs::File;
use std::io::BufReader;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use adom_store::MagnetBankStore;

use crate::store_admin::{tokens_match, AdminState};

/// Nome do spool: prefixo e extensão fixos. Sem isso a rota aceitaria qualquer
/// arquivo do disco do gateway.
const SPOOL_PREFIX: &str = "adom-magnets-import-";
const SPOOL_EXT: &str = ".ndjson";
/// Linhas por transação do backfill: lote curto para não segurar o SQLite.
const BACKFILL_BATCH: usize = 500;

/// Uma importação por vez. Não é fila: quem chega durante outra recebe 409,
/// porque duas mesclas no mesmo `magnets.db` disputariam as mesmas linhas.
static BUSY: AtomicBool = AtomicBool::new(false);

/// Libera `BUSY` no Drop, inclusive quando a importação entra em pânico.
struct BusyGuard;

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

fn acquire() -> Option<BusyGuard> {
    BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .ok()
        .map(|_| BusyGuard)
}

pub(crate) fn admin_router() -> Router<Arc<AdminState>> {
    Router::new().route("/magnet-bank/import", post(import))
}

/// `POST /magnet-bank/import`. A ordem das guardas importa: primeiro a
/// credencial (sem ela nem se lê o corpo), depois o `confirm`, depois o caminho,
/// e só então a trava de ocupação.
async fn import(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    // Corpo CRU, como no `suppressed-drain`: um JSON ilegível não confirma.
    body: Bytes,
) -> Response {
    let Some(expected) = state.destructive_token.as_deref() else {
        return refuse(StatusCode::CONFLICT, "magnet_bank_requires_admin_token");
    };
    if !tokens_match(expected, header_token(&headers)) {
        return refuse(StatusCode::FORBIDDEN, "magnet_bank_token_insufficient");
    }
    let parsed: Option<Value> = serde_json::from_slice(&body).ok();
    let confirmed = parsed
        .as_ref()
        .and_then(|value| value.get("confirm"))
        .and_then(Value::as_bool);
    if confirmed != Some(true) {
        return refuse(StatusCode::CONFLICT, "confirmation_required");
    }
    let raw_path = parsed
        .as_ref()
        .and_then(|value| value.get("path"))
        .and_then(Value::as_str)
        .unwrap_or("");
    // A existência do arquivo fica fora da guarda pura: `valid_spool_path` não
    // toca o disco, e um spool que sumiu entre o Node gravar e cá cai no mesmo 400.
    let Some(path) = valid_spool_path(raw_path).filter(|candidate| candidate.is_file()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "invalid_path" })),
        )
            .into_response();
    };
    let Some(guard) = acquire() else {
        return refuse(StatusCode::CONFLICT, "busy");
    };
    let joined = tokio::task::spawn_blocking(move || {
        // O guard entra no closure: sai de escopo (e libera `BUSY`) só quando a
        // importação termina, não quando o handler responde.
        let _guard = guard;
        let store = MagnetBankStore::from_env()?;
        run_import(&store, &path)
    })
    .await;
    match joined {
        Ok(Ok(value)) => {
            let status = if value["ok"] == json!(true) {
                StatusCode::OK
            } else {
                StatusCode::BAD_REQUEST
            };
            (status, Json(value)).into_response()
        }
        Ok(Err(err)) => internal(err),
        Err(join) => internal(join.to_string()),
    }
}

/// Importa o spool e, se o arquivo foi aceito, roda o backfill de classificação.
/// `Err` é só falha de I/O ou SQLite (vira 500); arquivo recusado pelo formato
/// volta `Ok` com `ok:false` (vira 400 com o relatório).
pub(crate) fn run_import(store: &MagnetBankStore, path: &Path) -> Result<Value, String> {
    let file = File::open(path).map_err(|err| format!("abrir spool: {err}"))?;
    let report = store.import_ndjson(BufReader::new(file))?;
    let backfilled = if report.ok {
        store.backfill_classification(BACKFILL_BATCH)?
    } else {
        0
    };
    let mut out = serde_json::to_value(&report).map_err(|err| err.to_string())?;
    out["backfilled"] = json!(backfilled);
    Ok(out)
}

/// Guarda PURA do caminho do spool: absoluto, sem `..`, nome `adom-magnets-import-*.ndjson`.
pub(crate) fn valid_spool_path(path: &str) -> Option<PathBuf> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return None;
    }
    if candidate
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return None;
    }
    let name = candidate.file_name()?.to_str()?;
    if !(name.starts_with(SPOOL_PREFIX) && name.ends_with(SPOOL_EXT)) {
        return None;
    }
    Some(candidate.to_path_buf())
}

/// Backfill da classificação no boot: linhas gravadas antes do núcleo ganhar a
/// classificação ficam sem ela até serem reescritas. Roda em thread própria
/// para o gateway subir sem esperar o banco, e nunca derruba o processo.
pub(crate) fn spawn_boot_backfill() {
    // Mesmo critério de `stream_config`: só o literal `false` desliga.
    if std::env::var("MAGNET_BANK").is_ok_and(|raw| raw.trim() == "false") {
        return;
    }
    std::thread::spawn(|| {
        let result = MagnetBankStore::from_env()
            .and_then(|store| store.backfill_classification(BACKFILL_BATCH));
        match result {
            Ok(0) => {}
            Ok(n) => eprintln!("[magnetbank] backfill de classificação: {n} magnet(s)"),
            Err(err) => eprintln!("[magnetbank] backfill de classificação falhou: {err}"),
        }
    });
}

/// Token do header (`X-Indexer-Test-Token`); ausente ou lixo vira vazio, que nunca casa.
fn header_token(headers: &HeaderMap) -> &str {
    headers
        .get("x-indexer-test-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

fn refuse(status: StatusCode, error: &'static str) -> Response {
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

fn internal(err: String) -> Response {
    eprintln!("[magnetbank] importação falhou: {err}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": err })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "magnet_bank_admin_tests.rs"]
mod tests;
