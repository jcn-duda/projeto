//! Handler `GET /streams/trace` da admin — saiu do `store_admin.rs` pela
//! catraca e para amarrar o recompute nativo da dívida 4.2(b) num módulo só.
//!
//! Contrato mantido EXATAMENTE (o consumidor é o `/stream-trace.json` do Node):
//! token da superfície, `type`/`id` validados (400), chave exata quando o Node
//! manda a dele, senão a build mais recente da obra, `found:false` sem entrada,
//! e nada de URL/magnet/apiKey na resposta. A ÚNICA mudança de contrato: quando
//! a entrada TEM lista (`found`) mas NÃO tem ledger, a resposta ganha
//! `recompute` — o porte do `RecomputeOutcome` do TS
//! (`crate::stream::trace_recompute`). `null` quando não dá para ser honesto
//! (boot desligado, instalação ilegível na chave, ledger presente ou sem
//! `searchMeta`); a foto NUNCA é gravada no store (estado atual ≠ ledger).

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use super::{util, AdminState};

/// `GET /streams/trace?type=&id=[&key=]`.
pub(super) async fn trace(
    State(state): State<Arc<AdminState>>,
    Query(params): Query<std::collections::BTreeMap<String, String>>,
) -> Response {
    let kind = params.get("type").map(String::as_str).unwrap_or("");
    let id = params.get("id").map(String::as_str).unwrap_or("");
    if kind != "movie" && kind != "series" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "type deve ser movie ou series" })),
        )
            .into_response();
    }
    if id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "id obrigatório" })),
        )
            .into_response();
    }
    let now = util::now_ms();
    let grace = state.grace_seconds;
    // Chave exata quando o Node manda a dele (mesma `streamsCacheKey`); senão a
    // leitura do operador, que escolhe a build mais recente da obra.
    let exact = params.get("key").map(String::as_str).unwrap_or("");
    let mut hit = None;
    if !exact.is_empty() {
        match state.store.trace_entry(exact, grace, now) {
            Ok(found) => hit = found,
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "error": err })),
                )
                    .into_response()
            }
        }
    }
    if hit.is_none() {
        match state.store.latest_trace(kind, id, grace, now) {
            Ok(found) => hit = found,
            Err(err) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "ok": false, "error": err })),
                )
                    .into_response()
            }
        }
    }
    let Some(hit) = hit else {
        return Json(json!({ "ok": true, "found": false, "source": "rust" })).into_response();
    };
    // Recompute NATIVO (dívida 4.2(b)): `found` && sem ledger ⇒ a foto de hoje
    // a partir da matéria quente (`idx:v14`/`raw:v1`/`mag:v1`/`dead:v3`), com a
    // MESMA régua do `RecomputeOutcome` do TS (o teste do Node é a régua).
    // Leitura quiet: zero rede, zero gravação.
    let recompute: Value =
        crate::stream::trace_recompute::core::recompute_for_hit(&hit, kind, id, now);
    let entry = &hit.value;
    Json(json!({
        "ok": true,
        "found": true,
        "source": "rust",
        "cache": {
            "remainingS": hit.remaining_s,
            "partial": entry.partial,
            "debridKnown": entry.debrid_known == Some(true),
            "stale": hit.stale,
        },
        // O ledger vai CRU (é o mesmo JSON que o Node serializa) e os itens só
        // com `name`/`infoHash` — a sonda `mode=live` do painel precisa dos
        // hashes, e nada de URL/magnet/apiKey sai daqui.
        "trace": entry.trace,
        "searchMeta": entry.search_meta,
        // Foto ATUAL do recompute (nunca gravada no store); `null` quando não
        // recomputa (sem boot, instalação ilegível na chave, ledger presente ou
        // sem `searchMeta`).
        "recompute": recompute,
        "streams": entry
            .streams
            .iter()
            .map(|item| json!({
                "name": item.name,
                "infoHash": util::stream_hash(item.info_hash.as_deref(), item.url.as_deref()),
            }))
            .filter(|item| item["infoHash"].as_str().is_some_and(|h| !h.is_empty()))
            .collect::<Vec<_>>(),
    }))
    .into_response()
}
