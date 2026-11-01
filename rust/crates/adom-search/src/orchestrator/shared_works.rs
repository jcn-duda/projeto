//! Marca os itens cujo hash o acervo já aprovou em outras obras — a evidência do
//! corte de magnet alheio do núcleo (`RelevanceRejectReason::ForeignMagnet`).
//!
//! Só filme: em série o hash se repete de forma legítima (pack, spin-off), e a
//! medição do corte foi feita só em filme. Banco fora ou sem linha não marca:
//! nesse caso a lista segue sem o corte, em vez de perder item bom.

use std::borrow::Cow;

use super::file_sizes::hashes_of;
use super::index_source::MagnetBankSource;
use super::meta::SearchMeta;
use crate::raw_item::RawItem;

pub(super) fn mark_shared_works<'a>(
    bank: Option<&dyn MagnetBankSource>,
    items: &'a [RawItem],
    meta: &SearchMeta,
    min_works: i64,
) -> Cow<'a, [RawItem]> {
    let Some(bank) = bank.filter(|_| min_works > 0 && meta.season.is_none()) else {
        return Cow::Borrowed(items);
    };
    let hashes = hashes_of(items);
    if hashes.is_empty() {
        return Cow::Borrowed(items);
    }
    let counts = bank.other_works_passed(&hashes, &meta.imdb_id);
    if !counts.values().any(|works| *works >= min_works) {
        return Cow::Borrowed(items);
    }
    let mut out = items.to_vec();
    for item in &mut out {
        item.shared_by_other_works = counts
            .get(&item.hash())
            .is_some_and(|works| *works >= min_works);
    }
    Cow::Owned(out)
}

#[cfg(test)]
#[path = "shared_works_tests.rs"]
mod shared_works_tests;
