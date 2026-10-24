//! Montagem do `SearchMeta` (queries, degraus e multiobra) das duas fontes.

use serde_json::{json, Value};

use super::meta::SearchMeta;

/// Pedaços já normalizados de uma obra, das duas fontes (rota Node e
/// [`super::meta_native::NativeMetaSource`]).
///
/// A montagem (queries, degraus, ptTitleDual, multiobra) mora em
/// [`build_search_meta`] — as duas fontes passam por AQUI para não divergirem
/// em título/aliases/ano/coleção.
pub(super) struct MetaParts {
    pub(super) imdb_id: String,
    pub(super) season: Option<i64>,
    pub(super) episode: Option<i64>,
    pub(super) name: String,
    pub(super) names: Vec<String>,
    pub(super) year: Value,
    pub(super) alt_year: Option<String>,
    pub(super) released: Option<String>,
    pub(super) first_aired: Option<String>,
    pub(super) episode_aired_at_ms: Option<i64>,
    pub(super) home_release_at: Option<i64>,
    /// Títulos do TMDB; `None` = a consulta não veio.
    pub(super) titles: Option<MetaTitles>,
    /// Raiz da coleção multiobra, já filtrada por ano conhecido.
    pub(super) collection_root: Option<String>,
    pub(super) episode_counts: Vec<(i64, i64)>,
}

/// Títulos do TMDB na forma crua que o `ptTitleDual` consome.
pub(super) struct MetaTitles {
    pub(super) pt: Option<String>,
    pub(super) original: Option<String>,
    pub(super) en: Option<String>,
    /// `titles.year` do TMDB (NÃO o ano de catálogo): a query pt-BR usa este.
    pub(super) year: Option<Value>,
}

/// Monta o [`SearchMeta`] — MESMA ordem do `doSearch`: nome/ano de
/// `resolveSearchNames`, `buildSearchQuery`, pt-BR quando o título difere do
/// original, degrau do original, varredura pt e multiobra.
pub(super) fn build_search_meta(parts: MetaParts) -> SearchMeta {
    let MetaParts {
        imdb_id,
        season,
        episode,
        name,
        names,
        year,
        alt_year,
        released,
        first_aired,
        episode_aired_at_ms,
        home_release_at,
        titles,
        collection_root,
        episode_counts,
    } = parts;
    let season_episode = json!({ "season": season, "episode": episode });
    let query =
        adom_core::build_search_query(&json!({ "name": name, "year": year }), &season_episode);
    let pt = titles.as_ref().and_then(|t| t.pt.as_deref());
    let original = titles.as_ref().and_then(|t| t.original.as_deref());
    let pt_query = match pt {
        Some(pt) if Some(pt) != original => Some(adom_core::build_search_query(
            &json!({
                "name": pt,
                "year": titles
                    .as_ref()
                    .and_then(|t| t.year.clone())
                    .unwrap_or(Value::Null),
            }),
            &season_episode,
        )),
        _ => None,
    };
    let sweep_query = adom_core::pt_sweep_query_for(pt, original);
    let original_query = adom_core::resolve_original_step_name(original, Some(name.as_str()));
    let pt_title = pt_query.as_ref().and(pt).map(str::to_string);
    // Contexto do `ptTitleDual`: o build in-process decide a origem DUAL pelo
    // título pt distinto — sem depender do flag que a rota anexa ao item.
    let titles_ctx = titles.map(|t| adom_core::PtTitleDualTitles {
        original: t.original,
        pt: t.pt,
        en: t.en,
    });
    let multi_work_root = collection_root.clone();
    SearchMeta {
        imdb_id,
        season,
        episode,
        name,
        names,
        year,
        alt_year,
        released,
        first_aired,
        episode_aired_at_ms,
        home_release_at,
        query,
        pt_title,
        titles: titles_ctx,
        pt_query,
        sweep_query,
        original_query,
        multi_work_root,
        multi_work_query: collection_root,
        episode_counts,
        is_demo: false,
    }
}
