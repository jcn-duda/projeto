//! Dono nativo do efeito `harvester_enqueue` (episódio seguinte, `miss`,
//! `gap`, `br-gap`): o pedido entra direto na fila do colhedor do gateway.
//!
//! Antes ele ia ao Node (`/internal/search/effects`), que só o devolvia ao
//! MESMO gateway por `POST /harvest/enqueue` na admin 8711 — dois saltos HTTP
//! para um enfileiramento que mora aqui. A forma do payload é a do corpo
//! daquela rota, então a validação é a mesma (`request_from_body`).
//!
//! O colhedor nasce DEPOIS do orquestrador (`harvest::spawn` recebe o
//! orquestrador), por isso o handle chega por um slot preenchido no boot,
//! como o do worker do Chupim. Slot vazio = colhedor desligado: o efeito
//! segue ao Node, exatamente como antes.

use std::sync::{Arc, OnceLock};

use serde_json::{Map, Value};

use crate::harvest::{request_from_body, HarvestHandle};

pub const HARVESTER_ENQUEUE: &str = "harvester_enqueue";

/// Handle do colhedor, preenchido uma vez no boot depois do `spawn`.
pub(crate) type HarvestSlot = Arc<OnceLock<HarvestHandle>>;

/// Resultado da oferta do efeito ao colhedor.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HarvestOffer {
    /// Enfileiramento disparado em fundo (aceite ou dedupe é do colhedor).
    Spawned,
    /// Payload fora da forma da rota admin: rejeitado, não vai ao Node.
    Invalid,
    /// Sem colhedor (slot vazio) ou sem runtime: segue ao Node, como antes.
    Unbound,
}

/// Valida e dispara o enfileiramento. Não espera a fila: o lote de efeitos é
/// fire-and-forget e a recusa (dedupe 12 h, teto) é decisão do colhedor.
pub(crate) fn offer(slot: &HarvestSlot, payload: &Map<String, Value>) -> HarvestOffer {
    let Some(handle) = slot.get() else {
        return HarvestOffer::Unbound;
    };
    let Some(request) = request_from_body(&Value::Object(payload.clone())) else {
        return HarvestOffer::Invalid;
    };
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return HarvestOffer::Unbound;
    };
    let handle = handle.clone();
    runtime.spawn(async move {
        handle.enqueue(request).await;
    });
    HarvestOffer::Spawned
}

#[cfg(test)]
#[path = "harvest_effect_tests.rs"]
mod harvest_effect_tests;
