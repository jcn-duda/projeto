//! Efeitos de cauda com dono nativo (T3-L7a).
//!
//! O gateway DECIDE e MONTA o `dub_audit` (`adom_search`); este módulo o
//! EXECUTA sem voltar ao Node. Todo o resto (`autofetch`, warmer, sonda BR,
//! colhedor…) segue para o alvo de sempre (`NodeTailEffects`), na ordem em que
//! chegou.
//!
//! A drenagem é fire-and-forget: a resposta do `/internal/search/effects` é
//! 202 e o interrogatório nunca entra no caminho de quem pediu a lista.

use std::sync::Arc;

use adom_search::orchestrator::{EffectsBatch, RouteFuture, TailEffects};
use adom_search::EffectsResponse;

use crate::dub_audit::{self, DubAudit};

/// Efeito cujo dono virou o gateway.
pub const DUB_AUDIT: &str = "dub_audit";

/// Intercepta `dub_audit` e delega o resto ao alvo (Node).
pub struct NativeTailEffects {
    rest: Arc<dyn TailEffects>,
    audit: Arc<DubAudit>,
}

impl NativeTailEffects {
    pub fn new(rest: Arc<dyn TailEffects>, audit: Arc<DubAudit>) -> Self {
        Self { rest, audit }
    }
}

impl TailEffects for NativeTailEffects {
    fn effects<'a>(&'a self, batch: EffectsBatch) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async move {
            let mut rest = Vec::with_capacity(batch.effects.len());
            let mut accepted = 0i64;
            let mut rejected = 0i64;
            for effect in batch.effects {
                if effect.kind != DUB_AUDIT {
                    rest.push(effect);
                    continue;
                }
                // Payload fora da forma é REJEITADO, nunca vira varredura.
                match dub_audit::parse_effect(&effect.payload) {
                    Some((_adapter, _api_key, candidates)) => {
                        self.audit.offer(&candidates);
                        accepted += 1;
                    }
                    None => {
                        eprintln!("[audit] efeito dub_audit rejeitado (payload inválido)");
                        rejected += 1;
                    }
                }
            }
            let mut ok = true;
            if !rest.is_empty() {
                let response = self
                    .rest
                    .effects(EffectsBatch {
                        encoded: batch.encoded,
                        effects: rest,
                    })
                    .await?;
                ok = response.ok;
                accepted += response.accepted;
                rejected += response.rejected;
            }
            // Um drain por vez é regra do próprio `DubAudit` (`in_flight`).
            if self.audit.pending() > 0 {
                let audit = self.audit.clone();
                tokio::spawn(async move {
                    audit.drain().await;
                });
            }
            Ok(EffectsResponse {
                ok,
                accepted,
                rejected,
            })
        })
    }
}

#[cfg(test)]
#[path = "tail_effects_tests.rs"]
mod tests;
