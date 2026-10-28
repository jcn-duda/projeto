//! Saída de um lote do Chupim: o que foi aceito, o que ficou na fila e os
//! motivos de desistência.
//!
//! Separado de [`super::enqueue`] pela catraca de linhas: é o CONTRATO com o
//! worker (`serve_jobs::enqueue_batch` lê `skips`/`refused`/`enqueued`/
//! `search_key`/`season_hints`), não a decisão.

use std::collections::BTreeMap;

use crate::autofetch::season_fill::SeasonHint;

/// Resultado de um lote: o que foi aceito, o que ficou na fila e os motivos.
#[derive(Debug, Default)]
pub(crate) struct Report {
    pub(crate) search_key: String,
    /// Hashes aceitos pelo debrid, com o id do transfer (vão para o lote).
    pub(crate) enqueued: Vec<(String, Option<String>)>,
    pub(crate) attempts: usize,
    pub(crate) deferred: usize,
    pub(crate) dropped: usize,
    pub(crate) queue_len: usize,
    /// Motivo de desistência → contagem (`autofetch.skip.<motivo>`).
    pub(crate) skips: BTreeMap<String, usize>,
    /// Fatos do PACK por hash (título do release, obra declarada). Vão para o
    /// lote do recheck; o preenchimento de temporada lê de lá.
    pub(crate) season_hints: BTreeMap<String, SeasonHint>,
    /// Lote inteiro recusado por um motivo só (sem escrita nenhuma).
    pub(crate) refused: Option<&'static str>,
}

impl Report {
    pub(super) fn skip(&mut self, label: &str) {
        *self.skips.entry(label.to_string()).or_default() += 1;
    }

    pub(super) fn refused(search_key: &str, label: &'static str) -> Self {
        Self {
            search_key: search_key.to_string(),
            refused: Some(label),
            ..Self::default()
        }
    }
}
