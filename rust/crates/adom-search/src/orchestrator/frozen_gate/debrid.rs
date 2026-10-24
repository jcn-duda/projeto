//! Debrid congelado: veredito de cache por hash da captura.

use std::collections::BTreeSet;

use serde_json::Value;

use adom_core::RankingStream;

use crate::list_builder::{DebridAnswer, DebridCheck};

use super::capture::DebridCall;
use crate::orchestrator::config::{DebridContext, DebridFactory};

// ── debrid congelado ────────────────────────────────────────────────────────

pub(super) struct FrozenDebridFactory {
    pub(super) call: DebridCall,
}

impl DebridFactory for FrozenDebridFactory {
    fn make(&self, _ctx: &DebridContext) -> Box<dyn DebridCheck + Send> {
        Box::new(FrozenDebridCheck {
            call: self.call.clone(),
            cached: self.call.cached.iter().cloned().collect(),
        })
    }
}

pub(super) struct FrozenDebridCheck {
    pub(super) call: DebridCall,
    pub(super) cached: BTreeSet<String>,
}

impl DebridCheck for FrozenDebridCheck {
    fn check(&mut self, stream: &RankingStream) -> DebridAnswer {
        let hash = stream
            .info_hash
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase();
        if self.call.applied_p2p.contains(&hash) {
            return DebridAnswer::P2p;
        }
        // Cache HERMÉTICO: o veredito por hash do check consolidado que gerou o
        // expected vence a régua global (`calls`). O `cached` do Node pode
        // coexistir com `known:false`/`unusable` (o ⚡ veio do memo `davail` da
        // conta) — é justamente o caso que o replay perdia.
        if let Some(result) = self.call.results.get(&hash) {
            if result.cached {
                return DebridAnswer::Cached { url: None };
            }
            if result.known {
                return DebridAnswer::Missing;
            }
            if result
                .unusable
                .as_ref()
                .and_then(Value::as_str)
                .is_some_and(|reason| reason == "p2p")
            {
                return DebridAnswer::P2p;
            }
            if result.unusable.is_some() {
                return DebridAnswer::Unusable;
            }
            return DebridAnswer::Unknown;
        }
        if self.call.unusable.is_some() {
            return DebridAnswer::Unusable;
        }
        if !self.call.known {
            return DebridAnswer::Unknown;
        }
        if self.cached.contains(&hash) {
            DebridAnswer::Cached { url: None }
        } else {
            DebridAnswer::Missing
        }
    }
}
