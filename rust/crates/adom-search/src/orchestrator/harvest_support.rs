//! Reuso da coleta e da gravação de índice FORA do caminho do `/stream`.
//!
//! O colhedor de fundo (worker do `adom-server`) faz o que o tail da busca faz
//! — converter item do Jackett em [`RawItem`], montar a entrada do índice e
//! gravar (`record` + marca `passed_filter` no banco vivo) — sem passar pelo
//! orquestrador (prazo de cliente, SWR, build) nem por rota HTTP interna.
//!
//! Nada aqui é uma SEGUNDA régua:
//!
//! - [`raw_items_from_jackett`] delega a
//!   [`super::jackett_collector::raw_from_jackett`];
//! - [`raw_items_from_bludv`] delega a
//!   [`super::bludv_collector::raw_from_bludv`];
//! - [`release_entry_for`] delega a [`super::finish::release_entry_parts`], o
//!   mesmo miolo de `release_entry`;
//! - [`record_release`] chama [`write_entry`], que é o corpo do
//!   `Orchestrator::write_native_index` (`late.rs`).
//!
//! Mexeu numa dessas réguas? Mexa na origem; aqui só se transporta.

use adom_core::BankRow;
use adom_sources::{BludvRawItem, JackettRawItem};

use crate::internal_types::ReleaseEntry;
use crate::raw_item::RawItem;

use super::index_source::{BankFilterCtx, MagnetBankSource, ReleaseIndexSource};

/// Itens do Jackett → lote cru do build, com a conversão do coletor nativo
/// (`raw_from_jackett`): `sources` sai do `tracker` (vazio = nenhum
/// `tracker:`), `size`/`seeders`/`publishedAt` intactos.
pub fn raw_items_from_jackett(items: Vec<JackettRawItem>) -> Vec<RawItem> {
    items
        .into_iter()
        .map(super::jackett_collector::raw_from_jackett)
        .collect()
}

/// Itens do BLUDV → lote cru do build, com a conversão do coletor nativo
/// (`raw_from_bludv`): tracker `"BLUDV"`, sem `indexer`, `fromAccount` falso.
pub fn raw_items_from_bludv(items: Vec<BludvRawItem>) -> Vec<RawItem> {
    items
        .into_iter()
        .map(super::bludv_collector::raw_from_bludv)
        .collect()
}

/// Entrada do índice de uma obra qualquer, montada com a régua do `/stream`
/// ([`super::finish::release_entry_parts`]): `items`/`entered`/`survivors`
/// iguais aos de [`release_entry`](super::finish::release_entry), e a reserva
/// 📦 (`from_fallback`) fora — reserva nunca se auto-perpetua.
///
/// `kind` existe porque o índice indexa por `(imdb, temporada, episódio)`:
/// filme com S/E herdado de outra fila cairia no balde errado, então `"movie"`
/// zera os dois. Qualquer outro valor PRESERVA o que veio — tipo desconhecido
/// não destrói dado.
///
/// `year` faz parte do descritor de obra do colhedor, mas [`ReleaseEntry`] não
/// tem campo de ano (o índice não o persiste): o parâmetro fica na assinatura
/// para o consumidor passar o descritor inteiro sem adaptação.
pub fn release_entry_for(
    imdb: &str,
    kind: &str,
    season: Option<i64>,
    episode: Option<i64>,
    year: Option<&str>,
    entered: &[RawItem],
    survivors: &[RawItem],
) -> ReleaseEntry {
    // O índice não guarda ano; ver o doc acima.
    let _ = year;
    let (season, episode) = if kind.trim().eq_ignore_ascii_case("movie") {
        (None, None)
    } else {
        (season, episode)
    };
    super::finish::release_entry_parts(imdb, season, episode, entered, survivors)
}

/// O que a gravação de UMA entrada produziu. Métrica e log ficam com o
/// chamador: o `/stream` conta `index.rust.*`; o colhedor só quer o resultado.
pub(crate) struct EntryWrite {
    pub index: Result<usize, String>,
    /// `false` = sem banco aberto: a marca do filtro não pôde ser gravada.
    pub bank_present: bool,
    /// `mark_filter_outcome` aceitou a marca.
    pub bank_marked: bool,
}

/// Régua da escrita nativa de UMA entrada: `record` no índice e, em seguida, a
/// marca `passed_filter` no banco vivo. A falha de uma NÃO impede a outra (é a
/// ordem do `write_native_index`: a marca sai mesmo com `record` errado).
pub(crate) fn write_entry(
    index: &dyn ReleaseIndexSource,
    entry: &ReleaseEntry,
    bank: Option<&dyn MagnetBankSource>,
    now_ms: i64,
) -> EntryWrite {
    let lookup = move |hashes: &[String]| -> Vec<BankRow> {
        bank.map(|bank| bank.bank_rows_many(hashes))
            .unwrap_or_default()
    };
    // O `lookup` é SEMPRE passado (sem banco resolve vazio): é o que o
    // `/stream` faz desde o R4 e o que o índice usa para `mediaSource`.
    let lookup_ref: &dyn Fn(&[String]) -> Vec<BankRow> = &lookup;
    let index = index.record(entry, now_ms, Some(lookup_ref));
    let Some(bank) = bank else {
        return EntryWrite {
            index,
            bank_present: false,
            bank_marked: false,
        };
    };
    let entered = entry.entered.as_deref().unwrap_or(&entry.items);
    let survivors = entry.survivors.as_deref().unwrap_or(&entry.items);
    let ctx = BankFilterCtx {
        imdb_id: entry.imdb.clone(),
        season: entry.season,
        episode: entry.episode,
    };
    EntryWrite {
        index,
        bank_present: true,
        bank_marked: bank.mark_filter_outcome(entered, survivors, &ctx, now_ms),
    }
}

/// Grava a entrada no índice (`idx:v14`) e marca o veredito do filtro no banco
/// vivo — a mesma sequência do `write_native_index`, sem métrica nem log.
///
/// `bank = None` grava só o índice (a marca degrada); falha do índice volta
/// como `Err` e NÃO desfaz a marca, como no `/stream`.
pub fn record_release(
    index: &dyn ReleaseIndexSource,
    entry: &ReleaseEntry,
    bank: Option<&dyn MagnetBankSource>,
    now_ms: i64,
) -> Result<usize, String> {
    write_entry(index, entry, bank, now_ms).index
}

#[cfg(test)]
#[path = "harvest_support_tests.rs"]
mod tests;
