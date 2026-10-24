//! Fusão pura de intenção FULL ↔ sonda. Sem SQLite e sem rede.

use crate::reason::reason_priority;
use crate::types::{HarvestEntry, PendingFull};

impl PendingFull {
    pub fn strongest(current: Option<Self>, incoming: Option<Self>) -> Option<Self> {
        match (current, incoming) {
            (None, next) => next,
            (some, None) => some,
            (Some(old), Some(new)) => {
                if reason_priority(&new.reason) > reason_priority(&old.reason) {
                    Some(new)
                } else {
                    Some(old)
                }
            }
        }
    }
}

impl HarvestEntry {
    pub fn pending_full(&self) -> Option<PendingFull> {
        if let Some(full) = &self.full_intent {
            return Some(full.clone());
        }
        (!self.br_probe || self.full_base).then(|| PendingFull {
            reason: self.reason.clone(),
            priority_at: (self.reason == "br-gap")
                .then_some(self.priority_at)
                .flatten(),
        })
    }

    pub(crate) fn normalize_intent(&mut self) {
        let full = self.pending_full();
        self.full_base = self.br_probe && full.is_some();
        self.full_intent = if self.br_probe { full } else { None };
    }

    pub(crate) fn merge_intent(&mut self, incoming: &HarvestEntry) {
        let full = PendingFull::strongest(self.pending_full(), incoming.pending_full());
        if reason_priority(&incoming.reason) > reason_priority(&self.reason) {
            self.reason = incoming.reason.clone();
            self.priority_at = (incoming.reason == "br-gap")
                .then_some(incoming.priority_at)
                .flatten();
        }
        self.br_probe |= incoming.br_probe;
        self.full_base = self.br_probe && full.is_some();
        self.full_intent = if self.br_probe { full } else { None };
    }
}

#[cfg(test)]
#[path = "intent_tests.rs"]
mod tests;
