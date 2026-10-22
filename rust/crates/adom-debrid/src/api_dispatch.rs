//! Despacho das rotas internas. O adaptador nasce por pedido e lê a base do
//! ambiente. Magnet ausente é `None`: o `default_magnet` fica no adaptador.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use adom_core::PlayHint;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use super::AppState;
use crate::alldebrid::AllDebrid;
use crate::alldebrid_cleanup::{account_scope, env_truthy, CleanupMode, CleanupPlan, DurablePeek};
use crate::debridlink::DebridLink;
use crate::error::{now_ms, DebridError};
use crate::http::HttpClient;
use crate::premiumize::Premiumize;
use crate::realdebrid::RealDebrid;
use crate::torbox::TorBox;

#[path = "api_alldebrid.rs"]
mod api_alldebrid;

#[path = "api_hint.rs"]
mod api_hint;
use api_hint::play_hint;

fn known(service: &str) -> bool {
    matches!(
        service,
        "premiumize" | "realdebrid" | "alldebrid" | "torbox" | "debridlink"
    )
}

const POLL_WAIT: Duration = Duration::from_millis(700); // espera do pollTorrent em produção

#[derive(Deserialize)]
struct RequestBody {
    service: String,
    #[serde(default)]
    hashes: Vec<String>,
    #[serde(default, rename = "apiKey")]
    api_key: String,
    #[serde(default, rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(default, rename = "fileHashes")]
    file_hashes: Vec<String>,
    #[serde(default, rename = "fileWaitTimeoutMs")]
    file_wait_timeout_ms: Option<u64>,
    #[serde(default)]
    hash: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    episode: Option<Value>,
    /// Resolve: ausente ou true não apaga. O hold mora no Node.
    #[serde(default)]
    held: Option<bool>,
    // ── Fatos da limpeza segura (AllDebrid) ─────────────────────────────────
    // `DEBRID_AL_CLEANUP=off` (default) ignora tudo e a checagem é read-only.
    /// O chamador carregou o snapshot `knownBefore` antes do upload.
    #[serde(default, rename = "inventoryLoaded")]
    inventory_loaded: bool,
    #[serde(default, rename = "knownBefore")]
    known_before: Vec<String>,
    /// Hashes protegidos (hold volátil + `adprot`) do lote.
    #[serde(default, rename = "heldHashes")]
    held_hashes: Vec<String>,
    /// O chamador prova que `heldHashes` cobre TODOS os holds vivos da conta.
    #[serde(default, rename = "holdsComplete")]
    holds_complete: bool,
    #[serde(default, rename = "dropReady")]
    drop_ready: Option<bool>,
    #[serde(default, rename = "dropUncached")]
    drop_uncached: Option<bool>,
}

pub(super) async fn check(State(state): State<Arc<AppState>>, raw: Bytes) -> Response {
    let Some(body) = parse_body(&raw) else {
        return bad_json();
    };
    // fileHashes no TS dispara directdl. A checagem daqui não escreve na conta.
    let _ = (&body.file_hashes, body.file_wait_timeout_ms);
    eprintln!(
        "[debrid] check service={} hashes={}",
        plain(&body.service),
        body.hashes.len()
    );
    if let Some(response) = reject_unknown(&state, &body.service) {
        return response;
    }
    // AllDebrid: upload real suja a conta, então a nativa responde aqui
    // (incondicional desde a R3) e a limpeza exige `DEBRID_AL_CLEANUP=on` +
    // os fatos no corpo (senão é read-only).
    if body.service == "alldebrid" {
        return check_alldebrid(&state, &body).await;
    }
    // PM / TorBox / RD / Debrid-Link: réguas do núcleo + ledger do RD.
    let outcome = match crate::verdict::check_service(
        &body.service,
        &body.api_key,
        &body.hashes,
        body.timeout_ms.map(Duration::from_millis),
        state.store.as_ref(),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(_) => return not_ported(&state, &body.service),
    };
    json_status(StatusCode::OK, crate::verdict::outcome_json(&outcome, &[]))
}

/// AllDebrid nativa. A rota entrega os fatos da limpeza (`inventoryLoaded`,
/// `knownBefore`, `heldHashes`, `holdsComplete`, `dropReady`, `dropUncached`)
/// porque o Rust não enxerga o hold volátil do autofetch, que mora no Node.
/// Sem `holdsComplete` — e o Node atual não manda — o plano nasce suprimido e
/// a checagem é read-only, como com `DEBRID_AL_CLEANUP=off`.
async fn check_alldebrid(state: &AppState, body: &RequestBody) -> Response {
    if body.api_key.trim().is_empty() {
        // Mesma semântica de `configured:false` da rota Node: sem chave
        // não há serviço, e unknown é melhor que "frio" (verdadeiro).
        state.metrics.inc("rust.debrid.api.alldebrid_no_key");
        return json_status(
            StatusCode::OK,
            json!({
                "cached": [],
                "blocked": [],
                "complete": false,
                "known": false,
                "unusable": Value::Null,
            }),
        );
    }
    state.metrics.inc("rust.debrid.api.alldebrid_check");
    let client = match http(state) {
        Ok(client) => client,
        Err(response) => return *response,
    };
    let cleanup = CleanupMode::from_env();
    // O leitor read-only do `cache.db` do Node tem dois papéis: filtro de UPLOAD
    // (`adrm:v1`, vale sempre) e guarda durável da limpeza (`adprot`/`adsub`,
    // só com a flag). O `blocked` tira do `/magnet/upload` o hash que a limpeza
    // apagou de propósito — sem ele a conta reenche a cada busca.
    let durable = DurablePeek::from_env();
    let account = account_scope(&body.api_key);
    let opts = crate::alldebrid::CheckOpts {
        timeout: body.timeout_ms.map(Duration::from_millis),
        batch_size: None,
        cleanup,
        // Sem a flag, drop_* é ignorado de propósito (read-only); com a flag,
        // o corpo manda e o default é o mesmo do Node.
        drop_ready: cleanup.is_on()
            && body
                .drop_ready
                .unwrap_or_else(|| env_truthy("DEBRID_DROP_READY", true)),
        drop_uncached: cleanup.is_on()
            && body
                .drop_uncached
                .unwrap_or_else(|| env_truthy("DEBRID_DROP_UNCACHED", true)),
        inventory_loaded: body.inventory_loaded,
        known_before: body.known_before.iter().cloned().collect::<HashSet<_>>(),
        held: body.held_hashes.iter().cloned().collect::<HashSet<_>>(),
        blocked: durable.blocked_hashes(&account, now_ms() as i64),
        holds_complete: body.holds_complete,
        durable: cleanup.is_on().then(|| Arc::new(durable)),
        kill_switch: None,
    };
    let ad = AllDebrid::new(client);
    match ad
        .check_cached_report(&body.api_key, &body.hashes, &opts)
        .await
    {
        Ok(report) => {
            state
                .metrics
                .add("rust.debrid.api.alldebrid_hashes", body.hashes.len() as u64);
            record_cleanup(state, report.cleanup.as_ref());
            // Fire-and-forget: a fila com backoff nunca segura a resposta.
            if let Some(plan) = report.cleanup.clone().filter(|plan| !plan.is_empty()) {
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    let ad = ad.clone();
                    let key = body.api_key.clone();
                    handle.spawn(async move {
                        let _ = plan.run(&ad, &key).await;
                    });
                }
            }
            let outcome = crate::verdict::cached_outcome(report.cached, report.complete);
            count_outcome(state, &outcome);
            json_status(
                StatusCode::OK,
                crate::verdict::outcome_json(&outcome, &report.blocked),
            )
        }
        Err(failure) => {
            // Auth/quota viram `unusable` (a lista volta P2P); rate limit sai
            // como `known:false`, igual ao caminho TS. A rota não devolve 501
            // depois de um upload real (segundo upload dobraria o lixo).
            let outcome = crate::verdict::error_outcome(&failure.error);
            count_outcome(state, &outcome);
            json_status(StatusCode::OK, crate::verdict::outcome_json(&outcome, &[]))
        }
    }
}

fn record_cleanup(state: &AppState, plan: Option<&CleanupPlan>) {
    let Some(plan) = plan else {
        return;
    };
    state.metrics.add(
        "rust.debrid.api.alldebrid_cleanup_planned",
        plan.target_count() as u64,
    );
    state.metrics.add(
        "rust.debrid.api.alldebrid_cleanup_protected",
        plan.protected as u64,
    );
    if let Some(reason) = plan.suppressed {
        let key = format!(
            "rust.debrid.api.alldebrid_cleanup_suppressed.{}",
            reason.as_str()
        );
        state.metrics.inc(&key);
    }
}

fn count_outcome(state: &AppState, outcome: &crate::verdict::CheckOutcome) {
    if outcome.unusable.is_some() {
        state.metrics.inc("rust.debrid.api.alldebrid_unusable");
    }
    if !outcome.known {
        state.metrics.inc("rust.debrid.api.alldebrid_unknown");
    }
}

pub(super) async fn link(State(state): State<Arc<AppState>>, raw: Bytes) -> Response {
    let Some(body) = parse_body(&raw) else {
        return bad_json();
    };
    eprintln!("[debrid] link service={}", plain(&body.service));
    if let Some(response) = reject_unknown(&state, &body.service) {
        return response;
    }
    let hint = play_hint(&body.episode);
    if !link_service(&body.service) {
        return not_ported(&state, &body.service);
    }
    let client = match http(&state) {
        Ok(client) => client,
        Err(response) => return *response,
    };
    if body.service == "alldebrid" {
        return api_alldebrid::link(&state, &body, client, &hint).await;
    }
    let result = resolve(&body, client, &hint).await;
    finish(&state, &body, result, |url| match url {
        Some(url) => json!({ "url": url }),
        None => Value::Null,
    })
}

pub(super) async fn account(State(state): State<Arc<AppState>>, raw: Bytes) -> Response {
    let Some(body) = parse_body(&raw) else {
        return bad_json();
    };
    eprintln!("[debrid] account service={}", plain(&body.service));
    if let Some(response) = reject_unknown(&state, &body.service) {
        return response;
    }
    let Some(status) = account_of(&state, &body).await else {
        return not_ported(&state, &body.service);
    };
    status
}

pub(super) async fn files(State(state): State<Arc<AppState>>, raw: Bytes) -> Response {
    let Some(body) = parse_body(&raw) else {
        return bad_json();
    };
    eprintln!("[debrid] files service={}", plain(&body.service));
    if let Some(response) = reject_unknown(&state, &body.service) {
        return response;
    }
    if body.service != "premiumize" {
        return not_ported(&state, &body.service);
    }
    let client = match http(&state) {
        Ok(client) => client,
        Err(response) => return *response,
    };
    let result = Premiumize::new(client)
        .fresh_file_link(&body.api_key, &body.hash, &body.path, None)
        .await;
    finish(&state, &body, result, |link| match link {
        Some(link) => json!({ "url": link.url, "size": link.size }),
        None => Value::Null,
    })
}

fn link_service(service: &str) -> bool {
    // Mesma lista do `/debrid/resolve` (`play::known_service`): um serviço a
    // mais aqui sem braço no `resolve` mandaria a chave ao adaptador errado.
    crate::play::known_service(service)
}

async fn resolve(
    body: &RequestBody,
    client: HttpClient,
    hint: &PlayHint,
) -> Result<Option<String>, DebridError> {
    match body.service.as_str() {
        "premiumize" => {
            Premiumize::new(client)
                .resolve_link(&body.api_key, &body.hash, hint, None)
                .await
        }
        "debridlink" => {
            DebridLink::new(client)
                .resolve_link(&body.api_key, &body.hash, hint, None, POLL_WAIT)
                .await
        }
        "torbox" => {
            TorBox::new(client)
                .resolve_link(&body.api_key, &body.hash, hint, None, POLL_WAIT)
                .await
        }
        _ => {
            RealDebrid::new(client)
                .resolve_link(&body.api_key, &body.hash, hint, None, POLL_WAIT)
                .await
        }
    }
}

async fn account_of(state: &AppState, body: &RequestBody) -> Option<Response> {
    let client = match body.service.as_str() {
        "premiumize" | "realdebrid" => match http(state) {
            Ok(client) => client,
            Err(response) => return Some(*response),
        },
        // Debrid-Link não tem account_status.
        _ => return None,
    };
    Some(match body.service.as_str() {
        "premiumize" => {
            let result = Premiumize::new(client).account_status(&body.api_key).await;
            finish(
                state,
                body,
                result,
                |status| json!({ "limitUsed": status.limit_used, "premiumUntil": status.premium_until }),
            )
        }
        _ => {
            let result = RealDebrid::new(client).account_status(&body.api_key).await;
            finish(state, body, result, |status| {
                json!({
                    "magnets": status.magnets,
                    "ready": status.ready,
                    "active": status.active,
                    "error": status.error,
                    "premiumUntil": status.premium_until,
                })
            })
        }
    })
}

fn finish<T>(
    state: &AppState,
    body: &RequestBody,
    result: Result<T, DebridError>,
    ok: impl FnOnce(T) -> Value,
) -> Response {
    match result {
        Ok(value) => json_status(StatusCode::OK, ok(value)),
        Err(err) => adapter_error(state, &body.service, &body.api_key, err),
    }
}

fn http(state: &AppState) -> Result<HttpClient, Box<Response>> {
    state
        .http
        .clone()
        .ok_or_else(|| Box::new(client_missing(state)))
}

fn parse_body(raw: &[u8]) -> Option<RequestBody> {
    serde_json::from_slice(raw).ok()
}

fn reject_unknown(state: &AppState, service: &str) -> Option<Response> {
    if known(service) {
        return None;
    }
    state.metrics.inc("rust.debrid.api.unknown_service");
    Some(json_status(
        StatusCode::BAD_REQUEST,
        json!({ "error": "unknown_service" }),
    ))
}

fn not_ported(state: &AppState, service: &str) -> Response {
    state.metrics.inc("rust.debrid.api.not_ported");
    json_status(
        StatusCode::NOT_IMPLEMENTED,
        json!({ "error": "service_not_ported", "service": service }),
    )
}

fn client_missing(state: &AppState) -> Response {
    state.metrics.inc("rust.debrid.api.adapter_error");
    eprintln!("[debrid] cliente http ausente");
    json_status(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": "other", "kind": "other", "message": "cliente http indisponivel" }),
    )
}

fn adapter_error(state: &AppState, service: &str, secret: &str, err: DebridError) -> Response {
    state.metrics.inc("rust.debrid.api.adapter_error");
    // Só o tipo: a mensagem do upstream pode carregar a URL com a chave.
    eprintln!(
        "[debrid] falha service={} kind={}",
        plain(service),
        err.kind()
    );
    let message = redact(err.message(), secret);
    let message = if message.trim().is_empty() {
        "falha no debrid".into()
    } else {
        message
    };
    json_status(
        play_status(&err),
        crate::resolve_effects::link_error_json(&err, &message),
    )
}

/// 401 fica com o token interno. Cada erro de play tem status próprio;
/// o que sobra é 500, e NoVideo não entra aí.
fn play_status(err: &DebridError) -> StatusCode {
    match err.kind() {
        "auth" => StatusCode::FORBIDDEN,
        "quota" => StatusCode::PAYMENT_REQUIRED,
        "rate_limit" => StatusCode::TOO_MANY_REQUESTS,
        "blocked" => StatusCode::UNAVAILABLE_FOR_LEGAL_REASONS,
        "no_video" => StatusCode::UNPROCESSABLE_ENTITY,
        "episode_pick" => StatusCode::CONFLICT,
        "work_pick" => StatusCode::PRECONDITION_FAILED,
        "dub_lie" => StatusCode::NOT_ACCEPTABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

fn redact(message: &str, secret: &str) -> String {
    let text = if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "[redacted]")
    };
    strip_query_key(&strip_query_key(&text, "apikey="), "apiKey=")
}

fn strip_query_key(text: &str, marker: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find(marker) {
        out.push_str(&rest[..index]);
        out.push_str(marker);
        out.push_str("[redacted]");
        rest = &rest[index + marker.len()..];
        let skip = rest.find(['&', ' ', '"', '\'']).unwrap_or(rest.len());
        rest = &rest[skip..];
    }
    out.push_str(rest);
    out
}

fn plain(service: &str) -> String {
    service
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect()
}

fn json_status(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

fn bad_json() -> Response {
    json_status(StatusCode::BAD_REQUEST, json!({ "error": "bad_request" }))
}
