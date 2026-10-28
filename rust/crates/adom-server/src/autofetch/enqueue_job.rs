//! Trabalho que chega pelo canal do worker do Chupim.
//!
//! Separado de [`super::enqueue`] pela catraca de linhas: aqui só há o FORMATO
//! do job e a decomposição do escopo — nenhuma decisão.

use serde_json::{Map, Value};

/// Trabalho que chega pelo canal: o kind do efeito, o escopo da conta e o
/// payload. O kind é o que separa o lote de debrid (`autofetch_batch`) da sonda
/// dirigida (`br_probe`) e do índice de temporada (`season_key`) — sem ele todo
/// job cairia em [`super::run`] e viraria `empty-batch`.
#[derive(Clone, Debug)]
pub(crate) struct Job {
    /// `autofetch_batch`, `br_probe` ou `season_key` (`tail_effects::*`).
    pub(crate) kind: String,
    /// `adapter:sha256(chave)` — o escopo do cofre, nunca a chave.
    pub(crate) scope: String,
    pub(crate) payload: Map<String, Value>,
}

impl Job {
    /// `(adapter, account)` do escopo, ou `None` quando o escopo não tem os dois
    /// lados (o lote é recusado como `no-scope`, sem tocar no KV).
    pub(super) fn parts(&self) -> Option<(&str, &str)> {
        let (adapter, account) = self.scope.split_once(':')?;
        (!adapter.is_empty() && !account.is_empty()).then_some((adapter, account))
    }
}
