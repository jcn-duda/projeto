//! Holds locais do lote de Chupim. Cada aquisição pertence à chamada que a
//! obteve; uma execução concorrente não solta nem reutiliza o hold alheio.
//!
//! O [`ObraGate`] viaja junto de propósito: o teto por OBRA do TS é estado de
//! MÓDULO (`autofetch-obra.ts:115`), compartilhado entre a busca imediata e o
//! dreno da fila. Aqui a instância única é a do laço do worker, e o enqueue e o
//! dreno a recebem pelo mesmo `&Holds` — sem isso cada passo teria a própria
//! contagem e o teto deixaria de existir na prática.

use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};

use super::obra::ObraGate;

#[derive(Default)]
pub(crate) struct Holds {
    inner: Mutex<HashSet<String>>,
    obra: ObraGate,
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

    /// Teto por obra: reservas voláteis + registro durável do processo.
    pub(in crate::autofetch) fn obra(&self) -> &ObraGate {
        &self.obra
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.lock().len()
    }
}

fn key(account: &str, hash: &str) -> String {
    format!("{account}:{}", hash.to_ascii_lowercase())
}
