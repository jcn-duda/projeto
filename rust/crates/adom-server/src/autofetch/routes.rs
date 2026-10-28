use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use crate::store_admin::AdminState;

use super::suppressed_step;
use super::worker::AutofetchStatus;

pub(crate) fn router() -> Router<Arc<AdminState>> {
    Router::new()
        .route("/autofetch", get(status))
        .route("/autofetch/config", post(config))
        .route("/autofetch/pause", post(pause))
        .route("/autofetch/drain", post(drain))
        .route("/autofetch/suppressed-drain", post(suppressed_drain))
}

/// Painel do worker. Além do retrato do laço ganha os campos da represa:
/// `suppressed` (profundidade) e `lastSuppressedDrain` (contadores + timestamp
/// do último passo) — os dois que o Node publica no `snapshot()`.
async fn status(State(state): State<Arc<AdminState>>) -> Response {
    let depth = press_depth(&state);
    let last = suppressed_step::last();
    let mut out = match state.autofetch.as_ref() {
        Some(handle) => serde_json::to_value(handle.status()).unwrap_or_else(|err| {
            eprintln!("[autofetch] status ilegível ({err}); painel vazio");
            json!({})
        }),
        // Sem worker (store indisponível) o contrato continua legível: o painel
        // vê `phase:"unavailable"` em vez de erro.
        None => json!({
            "enabled": false,
            "phase": "unavailable",
            "paused": false,
            "queueDepth": 0,
            "lots": 0,
            "inflight": false,
            "intervalMs": 60_000,
            "processed": 0,
            "skips": {},
            "lastError": null,
            "vaultAccounts": 0
        }),
    };
    with_press(&mut out, depth, last);
    Json(json!({ "ok": true, "status": out })).into_response()
}

async fn config(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    let Some(handle) = state.autofetch.as_ref() else {
        return unavailable();
    };
    let Some(config) = super::worker::parse_config(&body, &handle.config()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "configuração inválida ou campo não permitido" })),
        )
            .into_response();
    };
    match handle.update(config) {
        Ok(status) => Json(json!({ "ok": true, "status": status })).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "ok": false, "error": "configuração não persistida" })),
        )
            .into_response(),
    }
}

async fn pause(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    if body
        .as_object()
        .is_none_or(|obj| obj.len() != 1 || !obj.contains_key("paused"))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "pause exige somente o campo paused booleano" })),
        )
            .into_response();
    }
    config(State(state), Json(json!({ "paused": body["paused"] }))).await
}

/// Dreno administrativo da FILA. Com o worker `prepared` (trava desligada)
/// responde o contrato sem efeito: nenhuma entrada da fila é tocada, nenhum
/// debrid é chamado. Com o laço vivo o pedido vai para o canal
/// (`effect: requested`) e a passagem seguinte drena de verdade.
async fn drain(State(state): State<Arc<AdminState>>) -> Response {
    let Some(handle) = state.autofetch.as_ref() else {
        return unavailable();
    };
    let status = handle.status();
    let requested = status.enabled && handle.request_drain();
    Json(json!({
        "ok": true,
        "enabled": status.enabled,
        "phase": status.phase,
        "operation": "drain",
        "effect": if requested { "requested" } else { "none" },
        "drained": 0
    }))
    .into_response()
}

/// Dreno da represa (`autofetch:v3:sup:`) — o `drainSuppressed` do Node.
///
/// A rota é a ação do operador, então o passo roda AQUI e devolve contadores
/// reais: `drained` é a contagem de remoções confirmadas no serviço (o painel
/// pinta isso em "removidas"). Sem worker (`enabled:false`), sem KV ou sem a
/// fábrica do ciclo, responde `drained:0` + `reason` — nunca 500: painel
/// quebrado é pior que dreno adiado, e é o motivo que mantém o Node como dono
/// enquanto os dois existirem (`autofetchEffectApplied` só liga com
/// `effect:"applied"`, que exige chamada de serviço).
async fn suppressed_drain(State(state): State<Arc<AdminState>>) -> Response {
    let Some(handle) = state.autofetch.as_ref() else {
        return unavailable();
    };
    let status = handle.status();
    let depth = press_depth(&state);
    if !status.enabled {
        // Worker `prepared`: não há fábrica nem laço — quem drena é o Node.
        return press_skipped(&status, "worker-disabled", depth);
    }
    let Some(kv) = state.ownership_kv.as_deref() else {
        return press_skipped(&status, "kv-unavailable", depth);
    };
    let Some(factory) = suppressed_step::factory() else {
        return press_skipped(&status, "factory-unavailable", depth);
    };
    let now = adom_sources::now_ms();
    match suppressed_step::drain(kv, factory, suppressed_step::drain_max(), now).await {
        Ok(report) => {
            let removed = report.operations.saturating_sub(report.counters.failed);
            Json(json!({
                "ok": true,
                "enabled": status.enabled,
                "phase": status.phase,
                "operation": "suppressed-drain",
                "effect": if report.operations > 0 { "applied" } else { "none" },
                "drained": removed,
                "retried": report.counters.retried,
                "dropped": report.counters.dropped,
                "kept": report.counters.kept,
                "failed": report.counters.failed,
                "operations": report.operations,
                "suppressed": report.depth,
                "reason": if report.operations > 0 { None } else { Some(idle_reason(&report)) },
                "lastSuppressedDrain": report.snapshot(),
            }))
            .into_response()
        }
        Err(err) => {
            eprintln!("[autofetch] dreno da represa falhou: {err}");
            press_skipped(&status, "drain-failed", depth)
        }
    }
}

/// Resposta do passo que NÃO executou: `drained:0`, `effect:"none"` e o motivo
/// em texto (o painel mostra; o Node continua dono do dreno).
fn press_skipped(status: &AutofetchStatus, reason: &str, depth: Option<usize>) -> Response {
    Json(json!({
        "ok": true,
        "enabled": status.enabled,
        "phase": status.phase,
        "operation": "suppressed-drain",
        "effect": "none",
        "drained": 0,
        "retried": 0,
        "dropped": 0,
        "kept": 0,
        "failed": 0,
        "operations": 0,
        "suppressed": depth.unwrap_or(0),
        "reason": reason,
        "lastSuppressedDrain": suppressed_step::last(),
    }))
    .into_response()
}

/// Por que o passo não chamou o serviço: represa vazia ou nada elegível
/// (backoff, retenção viva, conta sem credencial, teto por passagem).
fn idle_reason(report: &suppressed_step::DrainReport) -> &'static str {
    if report.depth > 0 || report.counters.kept > 0 {
        "nothing-eligible"
    } else {
        "empty"
    }
}

/// Profundidade da represa lida do KV das CHAVES (`ownership_kv` é o MESMO
/// `cache.db` do worker, conexão própria em WAL — a admin não abre um segundo
/// banco).
///
/// O `GET /autofetch` passa a tocar o disco NESTE campo, contra a foto em
/// memória do resto do status: é a mesma varredura que o `snapshot()` do Node
/// faz (`_origem.suppressed = "duravel"`) e sem ela o painel não tem como provar
/// que a represa esvaziou. `None` = KV indisponível nesta instância.
fn press_depth(state: &AdminState) -> Option<usize> {
    let kv = state.ownership_kv.as_deref()?;
    match suppressed_step::count(kv, adom_sources::now_ms()) {
        Ok(depth) => Some(depth),
        Err(err) => {
            eprintln!("[autofetch] represa ilegível no status ({err}); contando 0");
            None
        }
    }
}

/// Campos de painel da represa: `suppressed` (número, como no Node),
/// `suppressedSource` (`kv` só quando a leitura deu certo) e
/// `lastSuppressedDrain` (`null` até o primeiro passo).
fn with_press(out: &mut Value, depth: Option<usize>, last: Option<Value>) {
    let Some(object) = out.as_object_mut() else {
        return;
    };
    object.insert("suppressed".into(), json!(depth.unwrap_or(0)));
    object.insert(
        "suppressedSource".into(),
        json!(if depth.is_some() { "kv" } else { "unavailable" }),
    );
    object.insert("lastSuppressedDrain".into(), last.unwrap_or(Value::Null));
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({ "ok": false, "error": "autofetch_worker_unavailable" })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "routes_tests.rs"]
mod tests;
