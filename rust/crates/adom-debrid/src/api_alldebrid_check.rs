//! Checagem AllDebrid da API interna: fatos da limpeza no corpo e resposta
//! normalizada. Mora fora do `api_dispatch` para caber na catraca de linhas.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::{http, json_status, AppState, RequestBody};
use crate::alldebrid::{AllDebrid, CheckOpts};
use crate::alldebrid_cleanup::{account_scope, env_truthy, CleanupMode, CleanupPlan, DurablePeek};
use crate::error::now_ms;
use crate::verdict::{cached_outcome, error_outcome, outcome_json, CheckOutcome};

/// AllDebrid nativa. A rota entrega os fatos da limpeza (`inventoryLoaded`,
/// `knownBefore`, `heldHashes`, `holdsComplete`, `dropReady`, `dropUncached`)
/// porque o Rust não enxerga o hold volátil do autofetch, que mora no Node.
/// Sem `holdsComplete` — e o Node atual não manda — o plano nasce suprimido e
/// a checagem é read-only, como com `DEBRID_AL_CLEANUP=off`.
pub(super) async fn check_alldebrid(
    state: &AppState,
    body: &RequestBody,
) -> axum::response::Response {
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
    let opts = CheckOpts {
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
            let outcome = cached_outcome(report.cached, report.complete);
            count_outcome(state, &outcome);
            json_status(StatusCode::OK, outcome_json(&outcome, &report.blocked))
        }
        Err(failure) => {
            // Auth/quota viram `unusable` (a lista volta P2P); rate limit sai
            // como `known:false`, igual ao caminho TS. A rota não devolve 501
            // depois de um upload real (segundo upload dobraria o lixo).
            let outcome = error_outcome(&failure.error);
            count_outcome(state, &outcome);
            json_status(StatusCode::OK, outcome_json(&outcome, &[]))
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

fn count_outcome(state: &AppState, outcome: &CheckOutcome) {
    if outcome.unusable.is_some() {
        state.metrics.inc("rust.debrid.api.alldebrid_unusable");
    }
    if !outcome.known {
        state.metrics.inc("rust.debrid.api.alldebrid_unknown");
    }
}
