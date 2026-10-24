//! Porte de `filterInventoryRelevant` (`src/utils/release-filters.ts`):
//! relevância de item do INVENTÁRIO da conta do debrid, o caminho estrito de
//! `filterRelevantRaw` MAIS a exceção de pack multi-obra da mesma franquia.
//!
//! O caminho estrito é o `filter_relevant_raw` de [`crate::release_filters`];
//! aqui só se acrescenta a exceção. Ela não vale para o caminho dos indexers
//! (resultado de tracker é palpite, coisa na conta é escolha já paga) e só
//! vale para filme (`season` ausente): pack de franquia de série morreria no
//! corte por episódio de qualquer forma.
//!
//! Os motivos de `onRejected` vêm do `RelevanceOutcome`, na mesma ordem do TS:
//! primeiro os não resgatados dos diretos, depois o resto.

use std::collections::HashSet;

use crate::franchise::is_multi_work_collection;
use crate::release_filters::{
    filter_relevant_raw, RelevanceItem, RelevanceOutcome, RelevanceQuery, RelevanceRejectReason,
    RelevanceSettings,
};
use crate::release_guards::text_years_contradict;
use crate::release_name_matching::{contains_token_run, franchise_roots};

/// `year` do catálogo como número, ou `0` (o `Number(... || 0)` do TS).
fn catalog_year_of(year: &str) -> i64 {
    crate::matching_decisions::first_year_in(year)
}

/// Devolve os índices mantidos (diretos primeiro, depois os resgatados), e os
/// motivos dos rejeitados em ordem de disparo.
pub fn filter_inventory_relevant(
    items: &[RelevanceItem],
    query: &RelevanceQuery,
    settings: &RelevanceSettings,
) -> RelevanceOutcome {
    if query.names.is_empty() {
        return RelevanceOutcome::default();
    }
    let direct_outcome = filter_relevant_raw(items, query, settings);
    let n = items.len();
    let mut reasons: Vec<Option<RelevanceRejectReason>> = vec![None; n];
    for (i, reason) in &direct_outcome.rejected {
        reasons[*i] = Some(*reason);
    }
    let direct = direct_outcome.kept;
    let direct_set: HashSet<usize> = direct.iter().copied().collect();
    // `reasons.get(item) || 'title'` do TS.
    let reason_of = |i: usize| reasons[i].unwrap_or(RelevanceRejectReason::Title);
    let mut rejected = Vec::new();

    if query.season.is_some() {
        for i in (0..n).filter(|i| !direct_set.contains(i)) {
            rejected.push((i, reason_of(i)));
        }
        return RelevanceOutcome {
            kept: direct,
            rejected,
        };
    }

    let leftovers: Vec<usize> = (0..n).filter(|i| !direct_set.contains(i)).collect();
    if leftovers.is_empty() {
        return RelevanceOutcome {
            kept: direct,
            rejected,
        };
    }
    let roots = franchise_roots(query.names);
    if roots.is_empty() {
        for i in leftovers {
            rejected.push((i, reason_of(i)));
        }
        return RelevanceOutcome {
            kept: direct,
            rejected,
        };
    }
    // O pack precisa COBRIR o ano do filme: "Resident Evil Saga Completa
    // (2002-2017)" pronto na conta saía como fonte do Resident Evil de 2026.
    // Sem ano no título o pack fica (a franquia decide).
    let catalog_year = catalog_year_of(query.year);
    let extra: Vec<usize> = leftovers
        .iter()
        .copied()
        .filter(|&i| {
            let title = title_of(&items[i]);
            is_multi_work_collection(title)
                && roots.iter().any(|root| contains_token_run(title, root))
                && !text_years_contradict(title, catalog_year)
        })
        .collect();
    let rescued: HashSet<usize> = extra.iter().copied().collect();
    for i in leftovers {
        if !rescued.contains(&i) {
            rejected.push((i, reason_of(i)));
        }
    }
    let mut kept = direct;
    kept.extend(extra);
    RelevanceOutcome { kept, rejected }
}

/// `item.title || item.Title || ''`, o mesmo `||` do TS.
fn title_of(item: &RelevanceItem) -> &str {
    item.title
        .as_deref()
        .filter(|s| !s.is_empty())
        .or_else(|| item.title_pascal.as_deref().filter(|s| !s.is_empty()))
        .unwrap_or("")
}
