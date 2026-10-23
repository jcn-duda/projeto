//! `/debrid/account` da API interna: o JSON de cada serviço com o MESMO shape
//! que o adaptador TS devolvia — o Node usa o `remote.json` direto
//! (`src/debrid/rust-remote.ts`). Debrid-Link não tem `accountStatus` no TS e
//! segue 501. Mora fora do `api_dispatch` para caber na catraca de linhas.

use axum::response::Response;
use serde_json::{json, Value};

use super::{finish, AppState, RequestBody};
use crate::alldebrid::{AccountStatus as AllDebridStatus, AllDebrid};
use crate::http::HttpClient;
use crate::premiumize::{AccountStatus as PremiumizeStatus, Premiumize};
use crate::realdebrid::{AccountStatus as RealDebridStatus, RealDebrid};
use crate::torbox::{AccountStatus as TorBoxStatus, TorBox};

/// Serviços com `accountStatus` no adaptador TS. O Debrid-Link fica de fora.
pub(super) fn supported(service: &str) -> bool {
    matches!(
        service,
        "premiumize" | "realdebrid" | "alldebrid" | "torbox"
    )
}

/// Uma chamada de rede por serviço, pelo mesmo cliente HTTP do resto da rota.
pub(super) async fn status(state: &AppState, body: &RequestBody, client: HttpClient) -> Response {
    match body.service.as_str() {
        "premiumize" => {
            let result = Premiumize::new(client).account_status(&body.api_key).await;
            finish(state, body, result, premiumize_json)
        }
        "alldebrid" => {
            let result = AllDebrid::new(client).account_status(&body.api_key).await;
            finish(state, body, result, alldebrid_json)
        }
        "torbox" => {
            let result = TorBox::new(client).account_status(&body.api_key).await;
            finish(state, body, result, torbox_json)
        }
        _ => {
            let result = RealDebrid::new(client).account_status(&body.api_key).await;
            finish(state, body, result, realdebrid_json)
        }
    }
}

/// Premiumize: `limitUsed` já vem preso em [0,1] e `premiumUntil` em ms.
fn premiumize_json(status: PremiumizeStatus) -> Value {
    json!({ "limitUsed": status.limit_used, "premiumUntil": status.premium_until })
}

/// Real-Debrid: a lista do TS, com `premiumUntil` em ms.
fn realdebrid_json(status: RealDebridStatus) -> Value {
    json!({
        "magnets": status.magnets,
        "ready": status.ready,
        "active": status.active,
        "error": status.error,
        "premiumUntil": status.premium_until,
    })
}

/// AllDebrid: o TS devolve `{magnets, ready, active, error, oldestAt}` — NÃO
/// existe `premiumUntil` aqui. `oldestAt` é o menor `uploadDate` em SEGUNDOS,
/// cru da API, e `null` quando nenhum magnet traz data (`reduce` com `null`).
fn alldebrid_json(status: AllDebridStatus) -> Value {
    json!({
        "magnets": status.magnets,
        "ready": status.ready,
        "active": status.active,
        "error": status.error,
        "oldestAt": status.oldest_at,
    })
}

/// TorBox: o TS devolve SÓ `{magnets, ready, active}`; `error` e `premiumUntil`
/// não existem nesse adaptador — campo a mais aqui não seria paridade.
fn torbox_json(status: TorBoxStatus) -> Value {
    json!({
        "magnets": status.magnets,
        "ready": status.ready,
        "active": status.active,
    })
}

#[cfg(test)]
#[path = "api_account_tests.rs"]
mod api_account_tests;
