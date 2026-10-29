//! Utilitários do `store_admin`, fora do roteador por causa da catraca.
//!
//! Duas funções puras que o `store_admin` usa para a sonda live e para o
//! relógio da graça. Sem estado, sem env, sem I/O. Mais a comparação de token,
//! que veio para cá pela catraca e é reexportada (`store_admin::tokens_match`).
//!
//! E o handler da rota que APAGA MAIS (`POST /streams/clear`), com as duas
//! guardas (credencial destrutiva + `confirm`): ele veio para cá porque o
//! `store_admin.rs` está exatamente no teto de 400 linhas da catraca.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use super::AdminState;

/// Hash do item para a sonda live: o campo quando existe (item P2P); senão o
/// segmento de 40 hex da URL relativa de `/resolve`.
pub(super) fn stream_hash(info_hash: Option<&str>, url: Option<&str>) -> String {
    if let Some(hash) = info_hash.filter(|h| !h.is_empty()) {
        return hash.to_ascii_lowercase();
    }
    let Some(url) = url else {
        return String::new();
    };
    url.split(|c: char| !c.is_ascii_hexdigit())
        .find(|part| part.len() == 40 && part.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Comparação em tempo constante (sem dependência nova): só o TAMANHO vaza, e
/// o tamanho de um token não é segredo. A rota DESTRUTIVA das varreduras usa a
/// MESMA função na segunda credencial (`al_sweeps_admin`).
pub(crate) fn tokens_match(expected: &str, got: &str) -> bool {
    let (expected, got) = (expected.as_bytes(), got.as_bytes());
    if expected.len() != got.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(got) {
        diff |= a ^ b;
    }
    diff == 0
}

/// Token do header (`X-Indexer-Test-Token`); ausente/lixo ⇒ vazio, que nunca
/// casa com a credencial esperada. `?token=` NUNCA autentica.
pub(super) fn header_token(headers: &HeaderMap) -> &str {
    headers
        .get("x-indexer-test-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

/// Corpo de recusa (mesma forma das rotas irmãs: `ok:false` + `error`/`reason`).
pub(super) fn fail(
    status: StatusCode,
    error: &'static str,
    reason: Option<&'static str>,
) -> Response {
    let mut body = json!({ "ok": false, "error": error });
    if let Some(reason) = reason {
        body["reason"] = json!(reason);
    }
    (status, Json(body)).into_response()
}

/// Credencial DESTRUTIVA — a MESMA regra do `POST /sweeps/run`.
///
/// O token do `auth` (o de diagnóstico, o mesmo de `/metrics.json` e dos
/// scripts) abre a superfície mas NÃO apaga cache: ausente na config ⇒ 409
/// `streams_requires_admin_token` (`reason:no_destructive_token`, recusa de
/// configuração depois de autenticado); só o de diagnóstico ⇒ 403
/// `streams_token_insufficient`. `Some` = pode apagar; a operação só acontece
/// depois disto E do `confirm`.
pub(super) fn guard_destructive(state: &AdminState, headers: &HeaderMap) -> Option<Response> {
    let Some(expected) = state.destructive_token.as_deref() else {
        return Some(fail(
            StatusCode::CONFLICT,
            "streams_requires_admin_token",
            Some("no_destructive_token"),
        ));
    };
    if !tokens_match(expected, header_token(headers)) {
        return Some(fail(
            StatusCode::FORBIDDEN,
            "streams_token_insufficient",
            Some("diagnostic_token"),
        ));
    }
    None
}

/// `POST /streams/clear` — limpeza do cache de listas (global ou por sufixo).
///
/// É a rota que apaga MAIS: sem `suffix` zera o namespace `streams:v21`
/// inteiro, de todas as instalações. Por isso carrega as duas guardas do
/// `POST /sweeps/run`, nesta ordem e ANTES de qualquer remoção: credencial
/// destrutiva (`guard_destructive`) e `{"confirm":true}`. Corpo ausente, `{}`,
/// `{"confirm":false}` e `{"confirm":"true"}` (string) recusam — só o literal
/// booleano confirma. O `confirm` vale também para o escopo `suffix`: apaga
/// dado de uma instalação de verdade.
pub(super) async fn clear(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(refusal) = guard_destructive(&state, &headers) {
        return refusal;
    }
    let body = body.map(|Json(value)| value).unwrap_or(Value::Null);
    if body.get("confirm").and_then(Value::as_bool) != Some(true) {
        return fail(StatusCode::CONFLICT, "confirmation_required", None);
    }
    let suffix = body.get("suffix").and_then(Value::as_str).unwrap_or("");
    match state.store.clear_by_suffix(suffix) {
        Ok(removed) => Json(json!({
            "ok": true,
            "removed": removed,
            "entries": state.store.len().unwrap_or(0),
            "scope": if suffix.is_empty() { "all" } else { "suffix" },
        }))
        .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}
