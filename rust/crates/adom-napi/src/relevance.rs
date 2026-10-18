//! Ponte NAPI do filtro de relevância: `filterRelevantRaw` e
//! `filterInventoryRelevant` (`src/utils/release-filters.ts`) decidem INTEIROS
//! no núcleo, numa chamada por lote. Saem só índices — nenhum veredito volta
//! campo a campo pela fronteira, que é o que tornava o caminho Rust mais lento
//! que o TS puro.
//!
//! A lógica é toda `adom_core::release_filters` / `adom_core::inventory_filter`
//! (com golden contra o TS do `esm`); aqui só há conversão de tipos.

use adom_core::{
    filter_inventory_relevant, filter_relevant_raw_for_year, RelevanceItem as CoreItem,
    RelevanceOutcome as CoreOutcome, RelevanceQuery as CoreQuery,
    RelevanceSettings as CoreSettings,
};
use napi_derive::napi;

/// Campos de `RawItem` que o filtro lê (`title || Title`, `magnet || MagnetUri`,
/// `Guid` para o `dn=`). `None`/vazio = ausente, como o `||` do JS.
#[napi(object)]
pub struct RelevanceEntry {
    pub title: Option<String>,
    pub title_pascal: Option<String>,
    pub magnet: Option<String>,
    pub magnet_uri: Option<String>,
    pub guid: Option<String>,
    pub is_br: bool,
}

/// Consulta, uma vez por lote. `year`/`alt_year` já vêm como texto
/// (`String(x ?? '')`); `multi_work_root` é a raiz da coleção multiobra.
#[napi(object)]
pub struct RelevanceQueryNapi {
    pub names: Vec<String>,
    pub year: String,
    pub alt_year: Option<String>,
    pub is_series: bool,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub multi_work_root: Option<String>,
    pub home_release_at: Option<i64>,
}

/// Config que o TS lê em tempo de chamada (`config.search`) e o relógio.
#[napi(object)]
pub struct RelevanceSettingsNapi {
    /// `Date.now()`, em ms.
    pub now_ms: i64,
    /// `config.search.preHomeReleaseCut`.
    pub pre_home_release_cut: bool,
    /// `config.search.preHomeReleaseMarginMs`.
    pub pre_home_release_margin_ms: i64,
    /// `config.search.titlePrecisionTailCut` (default `true`).
    pub title_precision_tail_cut: bool,
}

/// Rejeitado: índice do item e código do motivo (`RelevanceRejectReason`),
/// na ordem em que o TS dispara o `onRejected`. O rótulo (`'title'`,
/// `'magnet-year'`…) fica do lado Node: string não atravessa a fronteira.
#[napi(object)]
pub struct RelevanceRejected {
    pub index: u32,
    /// Código do motivo = posição em `REJECT_LABELS` do TS.
    pub reason: u32,
}

/// Resultado: índices mantidos e, em ordem de disparo, os rejeitados.
#[napi(object)]
pub struct RelevanceOutcomeNapi {
    pub kept: Vec<u32>,
    pub rejected: Vec<RelevanceRejected>,
}

fn to_items(entries: Vec<RelevanceEntry>) -> Vec<CoreItem> {
    entries
        .into_iter()
        .map(|e| CoreItem {
            title: e.title,
            title_pascal: e.title_pascal,
            magnet: e.magnet,
            magnet_uri: e.magnet_uri,
            guid: e.guid,
            is_br: e.is_br,
        })
        .collect()
}

/// Empréstimo dos donos da entrada: a `CoreQuery` não vive além da chamada.
fn with_query<R>(q: RelevanceQueryNapi, f: impl FnOnce(&CoreQuery) -> R) -> R {
    let is_series = q.is_series;
    let season = q.season;
    let episode = q.episode;
    let multi_work_root = q.multi_work_root.as_deref();
    let home_release_at = q.home_release_at;
    let (names, year, alt_year) = (q.names, q.year, q.alt_year);
    let query = CoreQuery {
        names: &names,
        year: &year,
        alt_year: alt_year.as_deref(),
        is_series,
        season,
        episode,
        multi_work_root,
        home_release_at,
    };
    f(&query)
}

fn to_settings(s: RelevanceSettingsNapi) -> CoreSettings {
    CoreSettings {
        now_ms: s.now_ms,
        pre_home_release_cut: s.pre_home_release_cut,
        pre_home_release_margin_ms: s.pre_home_release_margin_ms,
        title_precision_tail_cut: s.title_precision_tail_cut,
    }
}

fn to_outcome(out: CoreOutcome) -> RelevanceOutcomeNapi {
    RelevanceOutcomeNapi {
        kept: out.kept.into_iter().map(|i| i as u32).collect(),
        rejected: out
            .rejected
            .into_iter()
            .map(|(i, r)| RelevanceRejected {
                index: i as u32,
                reason: r as u32,
            })
            .collect(),
    }
}

/// `filterRelevantRaw`: com ano dual, vale o que passar por QUALQUER um.
#[napi(catch_unwind)]
pub fn filter_relevant_raw_napi(
    items: Vec<RelevanceEntry>,
    query: RelevanceQueryNapi,
    settings: RelevanceSettingsNapi,
) -> RelevanceOutcomeNapi {
    let items = to_items(items);
    let settings = to_settings(settings);
    with_query(query, |q| {
        to_outcome(adom_core::filter_relevant_raw(&items, q, &settings))
    })
}

/// `filterRelevantRawForYear`: corte por um ano só, sem o passe dual.
#[napi(catch_unwind)]
pub fn filter_relevant_raw_for_year_napi(
    items: Vec<RelevanceEntry>,
    query: RelevanceQueryNapi,
    settings: RelevanceSettingsNapi,
) -> RelevanceOutcomeNapi {
    let items = to_items(items);
    let settings = to_settings(settings);
    with_query(query, |q| {
        to_outcome(filter_relevant_raw_for_year(&items, q, &settings))
    })
}

/// `filterInventoryRelevant`: o caminho estrito MAIS a exceção de pack
/// multi-obra da mesma franquia (só filme, só inventário da conta).
#[napi(catch_unwind)]
pub fn filter_inventory_relevant_napi(
    items: Vec<RelevanceEntry>,
    query: RelevanceQueryNapi,
    settings: RelevanceSettingsNapi,
) -> RelevanceOutcomeNapi {
    let items = to_items(items);
    let settings = to_settings(settings);
    with_query(query, |q| {
        to_outcome(filter_inventory_relevant(&items, q, &settings))
    })
}

#[cfg(test)]
#[path = "relevance_tests.rs"]
mod tests;
