//! Rotas admin das varreduras: `GET /sweeps` e `POST /sweeps/run` na 8711.
//!
//! Montadas no roteador do `store_admin`: o `auth` de lá (token, loopback e 503
//! sem token) já cobre estas rotas — aqui NÃO existe autenticação própria nem
//! servidor novo. Toda resposta é JSON e nenhuma carrega `apiKey`, escopo de
//! conta, hash ou id de magnet: o status é operacional, não um dump do acervo.
//!
//! O `GET` nunca faz I/O na conta (só o snapshot em memória) e responde 200
//! mesmo desligado (`enabled:false` + `disabledReason`). O `POST` executa UM
//! tipo pelo `Sweeper` compartilhado, com o mesmo guard de anti-reentrada do
//! tick agendado: o corpo nunca eleva o modo e nunca traz credencial.
//!
//! DUAS credenciais de propósito: o token do `auth` global é o MESMO de
//! `/metrics.json`, `/dashboard-status.json` e dos scripts — qualquer ferramenta
//! de diagnóstico o conhece, então ele NÃO pode apagar magnet. O `POST` exige a
//! segunda credencial do `store_admin` (`STREAM_STORE_ADMIN_TOKEN` →
//! `DEBRID_INTERNAL_TOKEN`): ausente ⇒ 409 `sweeps_requires_admin_token`; token
//! de diagnóstico ⇒ 403 `sweeps_token_insufficient`. O `GET /sweeps` segue só
//! com o `auth` global.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use adom_debrid::alldebrid_sweeps::{SweepKind, SweepMode};

use crate::store_admin::{tokens_match, AdminState};

use super::env::SweepAdmin;
use super::{OutcomeSummary, TickReport};

/// Campos de credencial/escopo: a rota usa SEMPRE a conta do operador já
/// montada no `SweepAdmin`. Presente no corpo ⇒ 400 `operator_only`.
const FORBIDDEN: [&str; 4] = ["apiKey", "encoded", "service", "accountScope"];

pub(crate) fn router() -> Router<Arc<AdminState>> {
    Router::new()
        .route("/sweeps", get(status))
        .route("/sweeps/run", post(run))
}

/// `GET /sweeps` (§3.1): `ok` + o que está montado + a foto do agendador.
async fn status(State(state): State<Arc<AdminState>>) -> Response {
    let admin = state.sweeps.clone().unwrap_or_else(SweepAdmin::not_wired);
    let mut body = match admin.snapshot().to_json() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    body.insert("ok".into(), json!(true));
    body.insert("enabled".into(), json!(admin.enabled));
    body.insert("scheduled".into(), json!(admin.scheduled));
    body.insert("mode".into(), json!(admin.mode.as_str()));
    body.insert("intervalMs".into(), json!(admin.interval_ms));
    body.insert("disabledReason".into(), json!(admin.disabled_reason));
    Json(Value::Object(body)).into_response()
}

/// `POST /sweeps/run` (§3.2): campos proibidos → `kind` → runtime → credencial
/// DESTRUTIVA → `confirm` → execução. Um `kind` por chamada; não existe `all`.
async fn run(
    State(state): State<Arc<AdminState>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    let body = body.map(|Json(value)| value).unwrap_or(Value::Null);
    let has_credential = FORBIDDEN
        .iter()
        .any(|field| body.get(*field).is_some_and(|value| !value.is_null()));
    if has_credential {
        return fail(StatusCode::BAD_REQUEST, "operator_only", None);
    }
    let Some(kind) = body
        .get("kind")
        .and_then(Value::as_str)
        .and_then(SweepKind::parse)
    else {
        return fail(StatusCode::BAD_REQUEST, "invalid_kind", None);
    };
    let admin = state.sweeps.clone().unwrap_or_else(SweepAdmin::not_wired);
    let Some(sweeper) = admin.sweeper.clone() else {
        return unavailable(&admin);
    };
    // A credencial de DIAGNÓSTICO (a que abre este agente, `/metrics.json` e os
    // scripts) não apaga magnet: o pedido destrutivo exige a segunda credencial.
    let Some(expected) = state.destructive_token.as_deref() else {
        return fail(
            StatusCode::CONFLICT,
            "sweeps_requires_admin_token",
            Some("no_destructive_token"),
        );
    };
    if !tokens_match(expected, header_token(&headers)) {
        return fail(
            StatusCode::FORBIDDEN,
            "sweeps_token_insufficient",
            Some("diagnostic_token"),
        );
    }
    // `confirm` só existe para o destruidor: em ReadOnly o campo é ignorado.
    if admin.mode.deletes() && body.get("confirm").and_then(Value::as_bool) != Some(true) {
        return fail(StatusCode::CONFLICT, "confirmation_required", None);
    }
    let at = adom_sources::now_ms();
    // O run continua mesmo se o cliente cair (§3.3): o `GET` mostra `running`
    // até o `FlightGuard` soltar.
    let task = tokio::spawn(async move { sweeper.run_kind(kind, at).await });
    match task.await {
        Ok(report) if report.reentered => (
            StatusCode::CONFLICT,
            Json(json!({
                "ok": false,
                "error": "sweep_in_progress",
                "reason": "reentered",
                "running": true,
            })),
        )
            .into_response(),
        Ok(report) => Json(ran_json(kind, admin.mode, &report, at)).into_response(),
        Err(_) => fail(StatusCode::INTERNAL_SERVER_ERROR, "sweep_failed", None),
    }
}

/// Token do header (`X-Indexer-Test-Token`); ausente/lixo ⇒ vazio, que nunca
/// casa com a credencial esperada.
fn header_token(headers: &HeaderMap) -> &str {
    headers
        .get("x-indexer-test-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

/// Runtime ausente: 503 para conta/cliente (não é configuração corrigível no
/// corpo) e 409 para env desligado. Sempre com o motivo, nunca um 500 mudo.
fn unavailable(admin: &SweepAdmin) -> Response {
    match admin.disabled_reason {
        Some(reason @ ("no_operator_account" | "http_client_unavailable" | "not_wired")) => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "sweeps_unavailable",
            Some(reason),
        ),
        other => fail(
            StatusCode::CONFLICT,
            "sweeps_disabled",
            Some(other.unwrap_or("cleanup_off")),
        ),
    }
}

/// Corpo de sucesso (§3.2). `varridos`/`falhas` seguem para o toast atual do
/// painel; `swept`/`failed` são os nomes canônicos.
fn ran_json(kind: SweepKind, mode: SweepMode, report: &TickReport, at: i64) -> Value {
    let outcome = report.outcomes.iter().find(|item| item.kind == kind);
    let summary = outcome.map_or_else(|| OutcomeSummary::zero(kind), OutcomeSummary::new);
    json!({
        "ok": true,
        "kind": kind.as_str(),
        "ran": true,
        "mode": mode.as_str(),
        "applied": summary.applied,
        "planned": summary.planned,
        "swept": summary.swept,
        "varridos": summary.swept,
        "falhas": summary.failed,
        "failed": summary.failed,
        "blocked": summary.blocked,
        "calls": summary.calls,
        "stopped": summary.stopped,
        "missing": report.missing.contains(&kind),
        "reasons": summary.reasons,
        "at": at,
    })
}

fn fail(status: StatusCode, error: &'static str, reason: Option<&'static str>) -> Response {
    let mut body = json!({ "ok": false, "error": error });
    if let Some(reason) = reason {
        body["reason"] = json!(reason);
    }
    (status, Json(body)).into_response()
}
