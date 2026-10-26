//! Fence de geração do cache de busca (T1-C1/T1-C2).
//!
//! Mora fora do [`crate::cache`] só para o arquivo caber no teto de linhas; a
//! API pública continua a mesma (`crate::cache::{Fence, fence_valid,
//! obra_of_key}`, reexportada aqui).

/// Geração de uma lista: contador da OBRA (`gen:obra:movie|series:<tt…>`) e do
/// namespace inteiro (`gen:epoch`).
///
/// A busca captura a fence JUNTO da leitura (`get_fenced`) e só grava com ela
/// (`set_fenced`): a invalidação que chega no meio descarta a escrita em vez de
/// ressuscitar a lista velha (5H). O valor congelado aqui é o mesmo do
/// `StreamsStore` (T1-C1), que é quem persiste os contadores.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fence {
    pub obra: u64,
    pub epoch: u64,
}

/// A geração capturada ainda vale? Contadores só crescem, então `>=`: uma
/// fence capturada com a geração ATUAL continua válida.
pub fn fence_valid(captured: Fence, current: Fence) -> bool {
    captured.epoch >= current.epoch && captured.obra >= current.obra
}

/// Obra (`movie:tt…`/`series:tt…`) dona de uma chave `streams:v21`.
/// `None` = chave fora do formato (outro namespace, id não-IMDb) — sem obra,
/// a fence que vale é só a do epoch.
pub fn obra_of_key(cache_key: &str) -> Option<String> {
    let rest = cache_key.strip_prefix(adom_core::prefix("streams"))?;
    let (kind, after) = rest.split_once(':')?;
    if kind != "movie" && kind != "series" {
        return None;
    }
    // O escopo (JSON da config + conta) vem depois do id; o id é o 1º campo.
    let id = after.split_once(':').map_or(after, |(id, _)| id);
    let digits = id.strip_prefix("tt")?;
    let is_imdb = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    is_imdb.then(|| format!("{kind}:{id}"))
}
