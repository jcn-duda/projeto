//! Holds locais do lote de Chupim. Cada aquisição pertence à chamada que a
//! obteve; uma execução concorrente não solta nem reutiliza o hold alheio.

use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};

#[derive(Default)]
pub(crate) struct Holds {
    inner: Mutex<HashSet<String>>,
}

impl Holds {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `true` quando o hash passou a estar preso por ESTA chamada.
    pub(in crate::autofetch) fn acquire(&self, account: &str, hash: &str) -> bool {
        !account.is_empty() && !hash.is_empty() && self.lock().insert(key(account, hash))
    }

    pub(in crate::autofetch) fn release(&self, account: &str, hash: &str) -> bool {
        self.lock().remove(&key(account, hash))
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.lock().len()
    }
}

fn key(account: &str, hash: &str) -> String {
    format!("{account}:{}", hash.to_ascii_lowercase())
}
