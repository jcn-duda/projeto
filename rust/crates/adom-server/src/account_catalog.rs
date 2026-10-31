//! API administrativa do catálogo durável da conta do operador (`catalog.db`).
//!
//! Porte das rotas de `src/debrid/catalog-env.ts`, montadas no roteador admin
//! (loopback + `X-Indexer-Test-Token`, ver `store_admin`). Cada rota devolve o
//! JSON do TS, sempre HTTP 200, exceto as recusas de guarda.
//!
//! | rota | efeito |
//! |---|---|
//! | `GET /account-catalog/status` | relatório do banco (sem rede) |
//! | `POST /account-catalog/scan` | varredura da conta |
//! | `GET /account-catalog/dedup-preview` | plano de dedup (sem deleção) |
//! | `POST /account-catalog/dedup-apply` `{max?,confirm}` | DESTRUTIVA |
//! | `POST /account-catalog/audit` `{max?,concurrency?}` | auditoria de arquivos |
//! | `GET /account-catalog/list?bucket=&limit=` | linhas para escolher |
//! | `POST /account-catalog/manual-delete` `{serviceIds,confirm}` | DESTRUTIVA |
//! | `POST /account-catalog/audit-requeue` `{max?}` | devolve linhas à fila |
//! | `POST /account-catalog/cleanup-preview` `{includeKnown?}` | plano da limpeza |
//! | `POST /account-catalog/cleanup-apply` `{max?,includeKnown?,confirm}` | DESTRUTIVA |
//! | `GET /account-catalog/versions` | plano de versões da obra (T3) |
//!
//! Guardas das DESTRUTIVAS, nesta ordem e antes de qualquer efeito: sem a
//! credencial destrutiva configurada → 409 `catalog_requires_admin_token`; com
//! o token de diagnóstico → 403 `catalog_token_insufficient`; sem
//! `confirm:true` → 400 `confirm_required`. Só depois disto, o gate da conta
//! (`sem-debrid`, `sem-conta-operador`, ...) e a operação.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use adom_catalog::rows::CatalogStore;
use adom_debrid::alldebrid::AllDebrid;
use adom_debrid::alldebrid_cleanup::account_scope;
use adom_debrid::http::HttpClient;

use super::{tokens_match, AdminState};

#[path = "account_catalog_clean.rs"]
mod clean;
#[path = "account_catalog_facts.rs"]
mod facts;
#[path = "account_catalog_ops.rs"]
mod ops;
#[path = "account_catalog_port.rs"]
mod port;

#[cfg(test)]
#[path = "account_catalog_clean_tests.rs"]
mod clean_tests;
#[cfg(test)]
#[path = "account_catalog_ops_tests.rs"]
mod ops_tests;
#[cfg(test)]
#[path = "account_catalog_test_support.rs"]
mod support;
#[cfg(test)]
#[path = "account_catalog_tests.rs"]
mod tests;

use facts::ProdFacts;
use ops::{Deps, Knobs};
use port::AllDebridPort;

/// Env do caminho do banco (`CATALOG_DB_PATH`); padrão `data/catalog.db`.
const DB_PATH_ENV: &str = "CATALOG_DB_PATH";
const DB_PATH_DEFAULT: &str = "data/catalog.db";
const HINT_OPERADOR_DESATIVADO: &str = "DEBRID_API_KEY existe, mas o uso da conta do operador está desligado; ligue DEBRID_OPERATOR_ENV_ACCOUNT (só as features do painel) ou DEBRID_ALLOW_ENV_KEY (também herda a chave em instalações sem dk) e recrie a stack";

/// Banco aberto UMA vez. Falha fica registrada: as rotas respondem `erro`.
static CATALOG: OnceLock<Result<Arc<CatalogStore>, String>> = OnceLock::new();

fn store() -> Result<Arc<CatalogStore>, Value> {
    CATALOG
        .get_or_init(|| {
            let path = std::env::var(DB_PATH_ENV)
                .ok()
                .map(|raw| raw.trim().to_string())
                .filter(|raw| !raw.is_empty())
                .unwrap_or_else(|| DB_PATH_DEFAULT.to_string());
            CatalogStore::open(Path::new(&path))
                .map(Arc::new)
                .map_err(|err| {
                    eprintln!("[catalog] catalog.db indisponível ({path}): {err}");
                    err
                })
        })
        .clone()
        .map_err(|_| json!({ "ok": false, "reason": "erro" }))
}

/// Recusa do gate da conta, na ordem do `catalogContext` do TS. `None` = passa.
/// `operator_account_on` é `envOperatorAccount` (`DEBRID_ALLOW_ENV_KEY` ||
/// `DEBRID_OPERATOR_ENV_ACCOUNT`); a chave nunca entra na resposta.
pub(super) fn refusal(service: &str, api_key: &str, operator_account_on: bool) -> Option<Value> {
    if service.is_empty() {
        return Some(json!({ "ok": false, "reason": "sem-debrid" }));
    }
    // Só a AllDebrid tem a varredura da conta (`magnetList`).
    if service != "alldebrid" {
        return Some(json!({ "ok": false, "reason": "sem-adapter-catalogo" }));
    }
    if api_key.is_empty() {
        return Some(json!({ "ok": false, "reason": "sem-conta-operador" }));
    }
    if !operator_account_on {
        return Some(json!({
            "ok": false,
            "reason": "chave-operador-desativada",
            "hint": HINT_OPERADOR_DESATIVADO,
        }));
    }
    None
}

/// Monta o contexto da operação: gate da conta, banco e a porta da AllDebrid.
/// `Err` é a resposta pronta (recusa do gate ou erro de banco).
/// `envOperatorAccount` do TS: `DEBRID_ALLOW_ENV_KEY` ausente ou vazia vale `true`.
fn operator_account_on(allow_env_key: Option<&str>, operator_env: Option<&str>) -> bool {
    matches!(allow_env_key, None | Some("") | Some("true")) || operator_env == Some("true")
}

fn context() -> Result<Arc<Deps>, Value> {
    let service = std::env::var("DEBRID_SERVICE")
        .unwrap_or_default()
        .to_lowercase();
    let api_key = std::env::var("DEBRID_API_KEY")
        .unwrap_or_default()
        .trim()
        .to_string();
    let operator_on = operator_account_on(
        std::env::var("DEBRID_ALLOW_ENV_KEY").ok().as_deref(),
        std::env::var("DEBRID_OPERATOR_ENV_ACCOUNT").ok().as_deref(),
    );
    if let Some(refused) = refusal(&service, &api_key, operator_on) {
        return Err(refused);
    }
    let store = store()?;
    let scope = account_scope(&api_key);
    let client = HttpClient::new().map_err(|err| {
        eprintln!("[catalog] cliente HTTP indisponível: {}", err.kind());
        json!({ "ok": false, "reason": "erro" })
    })?;
    let ad = AllDebrid::new(client);
    let port = AllDebridPort::new(ad, api_key.clone(), scope.clone());
    let facts = ProdFacts::new(scope.clone(), api_key);
    Ok(Arc::new(Deps {
        store,
        account: scope,
        adapter: facts::ADAPTER.to_string(),
        port: Arc::new(port),
        facts: Arc::new(facts),
        knobs: Knobs::from_env(),
    }))
}

/// Credencial DESTRUTIVA, a mesma regra de `store_admin::guard_destructive`,
/// com os nomes de erro do catálogo.
fn guard(state: &AdminState, headers: &HeaderMap) -> Option<Response> {
    let Some(expected) = state.destructive_token.as_deref() else {
        return Some(refuse(StatusCode::CONFLICT, "catalog_requires_admin_token"));
    };
    let got = headers
        .get("x-indexer-test-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !tokens_match(expected, got) {
        return Some(refuse(StatusCode::FORBIDDEN, "catalog_token_insufficient"));
    }
    None
}

fn refuse(status: StatusCode, error: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": error }))).into_response()
}

/// Corpo cru: vazio ou inválido vira `Null` (nunca erro de extrator, que daria
/// outro status antes da guarda de `confirm`).
fn parse_body(body: &Bytes) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

/// Só o booleano literal `true` confirma uma destrutiva.
fn confirmed(body: &Value) -> bool {
    body.get("confirm").and_then(Value::as_bool) == Some(true)
}

/// Número opcional do corpo: aceita só JSON numérico finito, truncado.
fn num_arg(body: &Value, key: &str) -> Option<i64> {
    body.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .map(|value| value.trunc() as i64)
}

/// `serviceIds` como texto (`String(raw ?? '')` do TS). Vazios são ignorados
/// adiante; o que não é texto nem número vira vazio.
fn ids_arg(body: &Value) -> Vec<String> {
    body.get("serviceIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| match item {
                    Value::String(text) => text.clone(),
                    Value::Number(number) => number.to_string(),
                    _ => String::new(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn json_ok(value: Value) -> Response {
    Json(value).into_response()
}

pub(crate) fn admin_router() -> Router<Arc<AdminState>> {
    Router::new()
        .route("/account-catalog/status", get(status))
        .route("/account-catalog/scan", post(scan))
        .route("/account-catalog/dedup-preview", get(dedup_preview))
        .route("/account-catalog/dedup-apply", post(dedup_apply))
        .route("/account-catalog/audit", post(audit))
        .route("/account-catalog/list", get(list))
        .route("/account-catalog/manual-delete", post(manual_delete))
        .route("/account-catalog/audit-requeue", post(audit_requeue))
        .route("/account-catalog/cleanup-preview", post(cleanup_preview))
        .route("/account-catalog/cleanup-apply", post(cleanup_apply))
        .route("/account-catalog/versions", get(versions))
}

async fn status(State(_state): State<Arc<AdminState>>) -> Response {
    match context() {
        Ok(deps) => json_ok(ops::status(deps).await),
        Err(refused) => json_ok(refused),
    }
}

async fn scan(State(_state): State<Arc<AdminState>>) -> Response {
    match context() {
        Ok(deps) => json_ok(ops::scan(deps).await),
        Err(refused) => json_ok(refused),
    }
}

async fn dedup_preview(State(_state): State<Arc<AdminState>>) -> Response {
    match context() {
        Ok(deps) => json_ok(ops::dedup_preview(deps).await),
        Err(refused) => json_ok(refused),
    }
}

async fn dedup_apply(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(refusal) = guard(&state, &headers) {
        return refusal;
    }
    let body = parse_body(&body);
    if !confirmed(&body) {
        return refuse(StatusCode::BAD_REQUEST, "confirm_required");
    }
    match context() {
        Ok(deps) => json_ok(ops::dedup_apply(deps, num_arg(&body, "max")).await),
        Err(refused) => json_ok(refused),
    }
}

async fn audit(State(_state): State<Arc<AdminState>>, body: Bytes) -> Response {
    let body = parse_body(&body);
    match context() {
        Ok(deps) => {
            json_ok(clean::audit(deps, num_arg(&body, "max"), num_arg(&body, "concurrency")).await)
        }
        Err(refused) => json_ok(refused),
    }
}

async fn list(
    State(_state): State<Arc<AdminState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let bucket = params.get("bucket").cloned().unwrap_or_default();
    let limit = params
        .get("limit")
        .and_then(|raw| raw.trim().parse::<i64>().ok());
    match context() {
        Ok(deps) => json_ok(ops::list_rows(deps, bucket, limit).await),
        Err(refused) => json_ok(refused),
    }
}

async fn manual_delete(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(refusal) = guard(&state, &headers) {
        return refusal;
    }
    let body = parse_body(&body);
    if !confirmed(&body) {
        return refuse(StatusCode::BAD_REQUEST, "confirm_required");
    }
    let deps = match context() {
        Ok(deps) => deps,
        Err(refused) => return json_ok(refused),
    };
    let ids = ids_arg(&body);
    if ids.is_empty() {
        return json_ok(json!({ "ok": false, "reason": "sem-selecao" }));
    }
    json_ok(ops::manual_delete(deps, ids).await)
}

async fn audit_requeue(State(_state): State<Arc<AdminState>>, body: Bytes) -> Response {
    let body = parse_body(&body);
    match context() {
        Ok(deps) => json_ok(clean::audit_requeue(deps, num_arg(&body, "max")).await),
        Err(refused) => json_ok(refused),
    }
}

async fn cleanup_preview(State(_state): State<Arc<AdminState>>, body: Bytes) -> Response {
    let body = parse_body(&body);
    let include_known = body.get("includeKnown").and_then(Value::as_bool) == Some(true);
    match context() {
        Ok(deps) => json_ok(clean::cleanup_preview(deps, include_known).await),
        Err(refused) => json_ok(refused),
    }
}

async fn cleanup_apply(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(refusal) = guard(&state, &headers) {
        return refusal;
    }
    let body = parse_body(&body);
    if !confirmed(&body) {
        return refuse(StatusCode::BAD_REQUEST, "confirm_required");
    }
    let include_known = body.get("includeKnown").and_then(Value::as_bool) == Some(true);
    match context() {
        Ok(deps) => json_ok(clean::cleanup_apply(deps, num_arg(&body, "max"), include_known).await),
        Err(refused) => json_ok(refused),
    }
}

async fn versions(State(_state): State<Arc<AdminState>>) -> Response {
    match context() {
        Ok(deps) => json_ok(ops::versions(deps).await),
        Err(refused) => json_ok(refused),
    }
}
