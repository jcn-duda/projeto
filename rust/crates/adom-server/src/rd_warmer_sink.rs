//! Adaptação do sink do tail ao aquecedor RD; mantém o módulo principal sob a catraca.

use std::sync::{Arc, PoisonError};

use serde_json::Value;

use crate::tail_effects::NativeEffectSink;

use super::{Inner, Warmer, RD_WARMER};

impl NativeEffectSink for Warmer {
    fn offer(&self, kind: &str, payload: &Value, scope: Option<&str>) -> bool {
        if kind != RD_WARMER {
            return false;
        }
        let Some(scope) = scope.filter(|scope| is_rd_scope(scope)) else {
            return false;
        };
        if !payload.get("releases").is_some_and(Value::is_array) {
            return false;
        }
        self.publish(payload, scope);
        true
    }
}

pub(super) fn is_rd_scope(scope: &str) -> bool {
    scope
        .strip_prefix("realdebrid:")
        .is_some_and(|account| !account.is_empty())
}

/// Solta o `in_flight` mesmo em panic ou cancelamento da tarefa.
pub(super) struct FlightGuard {
    pub(super) inner: Arc<Inner>,
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        state.in_flight = false;
    }
}
