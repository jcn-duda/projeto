//! Rotas administrativas do banco de magnets (`magnets.db`) e backfill no boot.
//!
//! Rotas (montadas por `store_admin::router_with_ownership`, então herdam o
//! token de diagnóstico da superfície):
//!
//! | rota | efeito |
//! |---|---|
//! | `POST /magnet-bank/import` `{"path":"<spool>","confirm":true}` | mescla um NDJSON no acervo vivo + backfill de classificação — DESTRUTIVA + `confirm` |
//! | `GET /magnet-bank/status` | panorama do acervo vivo (totais, último visto, por indexer) — leitura do painel |
//! | `GET /magnet-bank/search?q=<hash\|trecho>&limit=<1..100>` | busca por hash (40-hex), trecho do título ou recentes — leitura do painel |
//! | `GET /magnet-bank/export` | streaming NDJSON do acervo inteiro (o backup que o Node servia) — leitura total |
//!
//! As três leituras usam a MESMA credencial destrutiva do import (o token de
//! diagnóstico não basta) e dispensam `confirm`: não escrevem nada. O
//! kill-switch `MAGNET_BANK` do env vira o `enabled` que o store devolve.
//!
//! Por que a importação é "destrutiva" se a mescla nunca apaga: ela GRAVA no
//! acervo permanente (URI, `is_br`, `lied` podem trocar de valor), e um arquivo
//! errado não tem como ser desfeito. Por isso exige a MESMA credencial do
//! `suppressed-drain` e o `confirm`, em vez do token de diagnóstico.
//!
//! O arquivo chega como spool que o Node grava em disco; a rota só lê caminho
//! que passa na guarda (`valid_spool_path`), para não virar leitor arbitrário.

use crate::magnet_bank_status_memo::{status_ttl_ms, STATUS_MEMO};
use std::fs::File;
use std::io::BufReader;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use adom_store::MagnetBankStore;

use crate::store_admin::{tokens_match, AdminState};

/// Nome do spool: prefixo e extensão fixos. Sem isso a rota aceitaria qualquer
/// arquivo do disco do gateway.
const SPOOL_PREFIX: &str = "adom-magnets-import-";
const SPOOL_EXT: &str = ".ndjson";
/// Linhas por transação do backfill: lote curto para não segurar o SQLite.
const BACKFILL_BATCH: usize = 500;
/// `limit` da busca: default e teto iguais aos do painel (`clampLimit` do
/// `magnet-bank-search.ts`) — a rota nativa não serve mais que a do Node.
const SEARCH_DEFAULT_LIMIT: i64 = 50;
const SEARCH_MAX_LIMIT: i64 = 100;

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
    Router::new()
        .route("/magnet-bank/import", post(import))
        .route("/magnet-bank/status", get(status))
        .route("/magnet-bank/search", get(search))
        // O export vive em módulo próprio (teto de 400 linhas): mesmo
        // `AdminState`, mesmas guardas.
        .route(
            "/magnet-bank/export",
            get(crate::magnet_bank_export::export),
        )
}

/// Guarda de credencial das rotas do banco — a MESMA do import: sem token
/// destrutivo configurado é 409 (nada a comparar) e token que não casa é 403.
/// A leitura também exige: a superfície é administrativa e o acervo é interno.
/// `None` = autorizado; `Some` = recusa pronta para devolver.
pub(crate) fn destructive_refusal(state: &AdminState, headers: &HeaderMap) -> Option<Response> {
    let Some(expected) = state.destructive_token.as_deref() else {
        return Some(refuse(
            StatusCode::CONFLICT,
            "magnet_bank_requires_admin_token",
        ));
    };
    (!tokens_match(expected, header_token(headers)))
        .then(|| refuse(StatusCode::FORBIDDEN, "magnet_bank_token_insufficient"))
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
    if let Some(refusal) = destructive_refusal(&state, &headers) {
        return refusal;
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
        let outcome = run_import(&store, &path);
        // Mesmo com falha: o lote anterior à falha pode ter entrado.
        STATUS_MEMO.invalidate();
        outcome
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
        Ok(Err(err)) => internal("importação", err),
        Err(join) => internal("importação", join.to_string()),
    }
}

/// `GET /magnet-bank/status`. Panorama do acervo para o painel: o store monta
/// o JSON (mesmo shape do `status()` do Node), a rota só aplica a credencial,
/// resolve o kill-switch e devolve 200. Falha de store/SQLite vira 500.
async fn status(State(state): State<Arc<AdminState>>, headers: HeaderMap) -> Response {
    if let Some(refusal) = destructive_refusal(&state, &headers) {
        return refusal;
    }
    let enabled = magnet_bank_enabled();
    let joined = tokio::task::spawn_blocking(move || {
        let compute =
            || MagnetBankStore::from_env().and_then(|store| status_payload(&store, enabled));
        // Desligado não abre o banco: não há agregação a poupar.
        if enabled {
            STATUS_MEMO.get_or_compute(adom_sources::now_ms(), status_ttl_ms(), compute)
        } else {
            compute()
        }
    })
    .await;
    match joined {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(Err(err)) => internal("leitura do status", err),
        Err(join) => internal("leitura do status", join.to_string()),
    }
}

/// Corpo do status SEM HTTP. O relógio entra por parâmetro (mesma régua dos
/// stores: o relógio nunca mora dentro do store).
fn status_payload(store: &MagnetBankStore, enabled: bool) -> Result<Value, String> {
    store.bank_status(adom_sources::now_ms(), enabled)
}

/// Query de `GET /magnet-bank/search`. Campo ausente é legítimo; tipo lixo cai
/// no default do [`search_limit`], como o `clampLimit` do painel.
#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: Option<String>,
    limit: Option<String>,
}

/// `GET /magnet-bank/search?q=<hash 40-hex|trecho do título>&limit=<1..100>`.
/// Query vazia devolve os recentes; erro de validação volta no próprio JSON do
/// store (`ok:false`) e falha de store/SQLite vira 500.
async fn search(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Response {
    if let Some(refusal) = destructive_refusal(&state, &headers) {
        return refusal;
    }
    let q = query.q.unwrap_or_default().trim().to_string();
    let limit = search_limit(query.limit.as_deref());
    let joined = tokio::task::spawn_blocking(move || {
        MagnetBankStore::from_env().and_then(|store| search_payload(&store, &q, limit))
    })
    .await;
    match joined {
        Ok(Ok(value)) => (StatusCode::OK, Json(value)).into_response(),
        Ok(Err(err)) => internal("busca do banco", err),
        Err(join) => internal("busca do banco", join.to_string()),
    }
}

/// Busca SEM HTTP: o store valida a query e devolve o payload do painel.
fn search_payload(store: &MagnetBankStore, q: &str, limit: i64) -> Result<Value, String> {
    store.bank_search(q, limit)
}

/// `limit` da query com a régua do painel: ausente/inválido/<=0 cai no default
/// 50; acima do teto corta em 100 (`clampLimit` do `magnet-bank-search.ts`).
fn search_limit(raw: Option<&str>) -> i64 {
    raw.and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|limit| *limit > 0)
        .map(|limit| limit.min(SEARCH_MAX_LIMIT))
        .unwrap_or(SEARCH_DEFAULT_LIMIT)
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

/// Kill-switch do banco: só o literal `false` (com trim) desliga — mesma régua
/// do `stream_config` e do boot do Node. Qualquer outro valor, ou ausência,
/// mantém o banco LIGADO.
pub(crate) fn magnet_bank_enabled() -> bool {
    !std::env::var("MAGNET_BANK").is_ok_and(|raw| raw.trim() == "false")
}

/// Backfill da classificação no boot: linhas gravadas antes do núcleo ganhar a
/// classificação ficam sem ela até serem reescritas. Roda em thread própria
/// para o gateway subir sem esperar o banco, e nunca derruba o processo.
pub(crate) fn spawn_boot_backfill() {
    if !magnet_bank_enabled() {
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

pub(crate) fn refuse(status: StatusCode, error: &'static str) -> Response {
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

pub(crate) fn internal(what: &str, err: String) -> Response {
    eprintln!("[magnetbank] {what} falhou: {err}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "ok": false, "error": err })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "magnet_bank_admin_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "magnet_bank_admin_read_tests.rs"]
/// Testes das leituras; o módulo de teste do export REUSA o lock de env
/// daqui (mesmas vars) e os helpers HTTP.
pub(crate) mod read_tests;
