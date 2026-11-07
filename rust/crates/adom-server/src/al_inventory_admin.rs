//! Rotas admin do inventário da AllDebrid: `GET /debrid/inventory` na 8711.
//!
//! Montada no roteador do `store_admin`: o `auth` de lá (loopback, token e 503
//! sem token) já cobre esta rota — aqui NÃO existe autenticação própria nem
//! servidor novo. Toda resposta é JSON e nenhuma carrega `apiKey`, escopo de
//! conta ou hash (a MESMA régua de `al_sweeps_admin`): o painel precisa saber
//! SE a referência da conta está viva e QUANTOS hashes ela protege, não o
//! acervo — hash de magnet é dump do inventário, e dump não viaja pela ponte.
//!
//! O `GET` nunca faz I/O na conta: lê só o snapshot em memória do
//! `adom_debrid::alldebrid_cleanup` — o MESMO `knownBefore` que a checagem de
//! limpeza usa, com o TTL (`ALLDEBRID_PREEXISTING_TTL_MS`) e o refresh em
//! fundo de lá. Sem snapshot (frio, vencido ou refresh em voo) `count` é
//! `null`: "não sei" é a resposta honesta — 0 diria "conta vazia" e o painel
//! pintaria um acervo protegido que nunca foi medido.
//!
//! A conta é a do OPERADOR (`DEBRID_SERVICE`/`DEBRID_API_KEY`, a mesma do
//! `/resolve`), lida a cada chamada: a rota é stateless e não acrescenta nada
//! ao `AdminState`. Sem conta do operador responde 200 com `enabled:false` +
//! `reason` (o painel mostra o estado, não um erro) — o mesmo contrato do
//! `GET /sweeps` desligado.

use std::sync::Arc;

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};

use adom_debrid::alldebrid_cleanup::{account_scope, known_before};

use crate::store_admin::AdminState;

pub(crate) fn router() -> Router<Arc<AdminState>> {
    Router::new().route("/debrid/inventory", get(status))
}

/// Conta do operador: a MESMA régua das varreduras
/// (`operator_account::alldebrid_key_from_env`), para a foto e o agendador não
/// divergirem sobre qual conta existe.
fn operator_account() -> Option<String> {
    crate::operator_account::alldebrid_key_from_env()
}

/// `GET /debrid/inventory` — foto do `knownBefore` da conta do operador.
async fn status(State(_state): State<Arc<AdminState>>) -> Response {
    let now = adom_sources::now_ms();
    let Some(api_key) = operator_account() else {
        return Json(json!({
            "ok": true,
            "enabled": false,
            "reason": "no_operator_account",
            "count": Value::Null,
            "at": now,
        }))
        .into_response();
    };
    // O escopo (sha256 da chave) casa com `adprot`/`adsub`/`adrm` e com o
    // inventário do Node; ele NÃO sai na resposta.
    let scope = account_scope(&api_key);
    let count = known_before(&scope).map(|set| set.len());
    Json(json!({
        "ok": true,
        "enabled": true,
        "reason": Value::Null,
        "count": count,
        "at": now,
    }))
    .into_response()
}

#[cfg(test)]
#[path = "al_inventory_admin_tests.rs"]
mod tests;
