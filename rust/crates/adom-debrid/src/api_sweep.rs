//! `POST /debrid/sweep-dead`: varredura das transferências mortas ou paradas
//! do Premiumize (porte de `sweepDead`). A decisão é `premiumize_sweep`; aqui
//! ficam a leitura (lista, markers, holds), a remoção e a memória de paradas.
//! Só Premiumize: os outros serviços respondem 501 (não portados).

use std::sync::Arc;

use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;

use super::{adapter_error, bad_json, http, json_status, reject_unknown, AppState};
use crate::alldebrid_cleanup::{account_scope, is_held};
use crate::premiumize::Premiumize;
use crate::premiumize_sweep::{by_id_from_markers, marker_prefix, memory_key, plan_sweep};

/// Default de `sweepDeadMinAgeMs` no TS (`src/config/debrid.ts`): 30 min.
const DEFAULT_MIN_AGE_MS: i64 = 30 * 60 * 1000;

#[derive(Deserialize)]
struct SweepBody {
    service: String,
    #[serde(default, rename = "apiKey")]
    api_key: String,
    #[serde(default, rename = "minAgeMs")]
    min_age_ms: Option<i64>,
}

pub(super) async fn post(state: Arc<AppState>, raw: Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<SweepBody>(&raw) else {
        return bad_json();
    };
    if body.api_key.is_empty() {
        return bad_json();
    }
    if let Some(response) = reject_unknown(&state, &body.service) {
        return response;
    }
    if body.service != "premiumize" {
        state.metrics.inc("rust.debrid.api.not_ported");
        return json_status(
            StatusCode::NOT_IMPLEMENTED,
            json!({ "error": "not_ported" }),
        );
    }
    let client = match http(&state) {
        Ok(client) => client,
        Err(response) => return *response,
    };
    eprintln!("[debrid] sweep-dead service=premiumize");
    let now = crate::error::now_ms() as i64;
    let min_age = body.min_age_ms.unwrap_or_else(default_min_age).max(0);
    let account = account_scope(&body.api_key);
    let pm = Premiumize::new(client);

    let transfers = match pm.list_transfers(&body.api_key).await {
        Ok(transfers) => transfers,
        Err(err) => return adapter_error(&state, &body.service, &body.api_key, err),
    };
    // Sem store ou com leitura falha, o mapa sai vazio: transferência sem hash
    // pela cascata fica de fora (o lado seguro).
    let rows = state
        .store
        .as_ref()
        .and_then(|store| store.prefix_values(&marker_prefix(&account), now).ok())
        .unwrap_or_default();
    let by_id = by_id_from_markers(&rows, &account);

    // Hold ilegível conta como segurado (fail-closed). O hold do processo
    // (`cleanup_holds`) também protege, por ser mais conservador.
    let plan = {
        let mut memory = state
            .sweep_memory
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let held = |hash: &str| {
            state
                .durable
                .is_held_checked(&account, hash, now)
                .unwrap_or(true)
                || is_held(&account, hash)
        };
        plan_sweep(
            &transfers,
            &by_id,
            held,
            &mut memory,
            &account,
            now,
            min_age,
        )
    };

    let mut ok = 0usize;
    let mut falhas = 0usize;
    for (id, hash) in &plan.targets {
        match pm.remove_torrent(&body.api_key, id).await {
            Ok(()) => {
                ok += 1;
                if let Some(hash) = hash {
                    let mut memory = state
                        .sweep_memory
                        .lock()
                        .unwrap_or_else(|err| err.into_inner());
                    memory.remove(&memory_key(&account, hash));
                }
            }
            Err(_) => falhas += 1,
        }
    }

    let total = plan.targets.len();
    if total > 0 {
        let sufixo = if falhas > 0 {
            format!(" — {falhas} falhou(ram)")
        } else {
            String::new()
        };
        eprintln!(
            "[premiumize] varredura: {ok}/{total} transferência(s) morta(s) ou parada(s) removida(s){sufixo}"
        );
    }
    json_status(
        StatusCode::OK,
        json!({ "varridos": ok, "falhas": falhas, "observados": plan.observed }),
    )
}

/// `DEBRID_SWEEP_DEAD_MIN_AGE_MS` (mesma env do TS), senão 30 min.
fn default_min_age() -> i64 {
    std::env::var("DEBRID_SWEEP_DEAD_MIN_AGE_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_MIN_AGE_MS)
}
