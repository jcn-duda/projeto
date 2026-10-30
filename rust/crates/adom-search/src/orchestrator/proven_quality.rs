//! Resolução PROVADA pelo arquivo do torrent (`provenQuality`).
//!
//! Porte do `stampProvenQuality` do TS (`src/providers/probed-quality.ts`,
//! apagado no `89f170d5` junto com o pipeline TS): o `map_stream` já lia
//! `RawItem::proven_quality` antes do título, mas no corte nativo ninguém o
//! preenchia. Release cujo título não diz a resolução ("Remaster BluRay BR" do
//! Mico, "FILMOGRAFIA COMPLETA…") saía sem chip de qualidade e caía no balde
//! "sem resolução" do corte por qualidade, mesmo com a lista de arquivos do
//! hash já conhecida.
//!
//! Régua do TS, sem a medição de cabeçalho (`vres`, que não tem dono nativo):
//! título sem resolução → lista de arquivos do hash (`fsz`, a mesma do 💾) →
//! o arquivo que o play tocaria (`pick_file`, com S/E ou a dica de obra) → a
//! resolução do NOME desse arquivo. Sem lista, lista ambígua ou nome sem
//! resolução, nada é inventado.

use std::borrow::Cow;
use std::collections::BTreeMap;

use adom_core::{
    base_name, is_multi_work_collection, pick_file, quality_from_title, DebridFile, PickOutcome,
    PlayHint, WorkHint, UNKNOWN_QUALITY,
};
use serde_json::Value;

use crate::raw_item::RawItem;

use super::meta::SearchMeta;

/// Ano da obra para a dica de obra: número, ou o primeiro número de 4 dígitos
/// de um texto sujo ("2024–").
fn year_of(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_i64().filter(|year| *year > 0),
        Value::String(text) => text
            .split(|c: char| !c.is_ascii_digit())
            .find(|part| part.len() == 4)
            .and_then(|part| part.parse().ok()),
        _ => None,
    }
}

/// Resolução do arquivo que o play tocaria; `None` = sem prova.
fn proven_for(files: &[DebridFile], title: &str, meta: &SearchMeta) -> Option<String> {
    let work = if meta.season.is_none() && !meta.names.is_empty() {
        Some(WorkHint {
            names: meta.names.clone(),
            year: year_of(&meta.year),
            pack: is_multi_work_collection(title),
        })
    } else {
        None
    };
    let hint = PlayHint {
        season: meta.season,
        episode: meta.episode,
        work,
        dubbed: false,
    };
    let PickOutcome::File { path, .. } = pick_file(files, &hint) else {
        return None;
    };
    let quality = quality_from_title(&base_name(&path)).to_string();
    (quality != UNKNOWN_QUALITY).then_some(quality)
}

/// Carimba `proven_quality` nos itens sem resolução no título. Só clona a lista
/// quando algum item ganha prova (o caso comum não paga cópia).
pub(super) fn stamp_proven_quality<'a>(
    items: &'a [RawItem],
    files_by_hash: &BTreeMap<String, Vec<DebridFile>>,
    meta: &SearchMeta,
) -> Cow<'a, [RawItem]> {
    if files_by_hash.is_empty() {
        return Cow::Borrowed(items);
    }
    let mut stamped: Option<Vec<RawItem>> = None;
    for (index, item) in items.iter().enumerate() {
        if item.proven_quality.is_some() {
            continue;
        }
        let title = item.title_text();
        if quality_from_title(title) != UNKNOWN_QUALITY {
            continue;
        }
        let hash = item.hash();
        let Some(files) = files_by_hash.get(&hash) else {
            continue;
        };
        let Some(quality) = proven_for(files, title, meta) else {
            continue;
        };
        let list = stamped.get_or_insert_with(|| items.to_vec());
        list[index].proven_quality = Some(quality);
    }
    match stamped {
        Some(list) => Cow::Owned(list),
        None => Cow::Borrowed(items),
    }
}

#[cfg(test)]
#[path = "proven_quality_tests.rs"]
mod proven_quality_tests;
