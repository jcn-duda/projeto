//! Conversões puras do drain (sem rede): env dos isentos da busca viva, o id
//! do `MetaQuery` e os campos que a régua lê.
//!
//! Ficam fora de `drain.rs` só para a catraca de linhas; nenhuma régua nova
//! nasce aqui.

use adom_core::RelevanceItem;
use adom_harvest::HarvestEntry;
use adom_search::orchestrator::MetaQuery;
use adom_sources::JackettRawItem;

/// Default do Node para `JACKETT_LIVE_EXEMPT_INDEXERS` (o `adom-search` guarda
/// o dele em `pub(super)`; aqui a lista é só para o subset da sonda).
pub(super) const DEFAULT_LIVE_EXEMPT: &str = "apachetorrent-cardigann";

/// `JACKETT_LIVE_EXEMPT_INDEXERS` do processo (env presente manda, mesmo
/// vazia; ausente = default do Node).
pub(super) fn live_exempt_indexers() -> Vec<String> {
    std::env::var("JACKETT_LIVE_EXEMPT_INDEXERS")
        .ok()
        .map(|raw| {
            let ids: Vec<String> = raw
                .split(',')
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect();
            // Rename dos ids aposentados (mesmo mapa do TS): a env é a MESMA
            // que o Node lê, então os dois lados precisam casar o mesmo id.
            adom_core::rename_indexer_ids(&ids)
        })
        .unwrap_or_else(|| vec![DEFAULT_LIVE_EXEMPT.to_string()])
}

/// Id do `MetaQuery`: `tt…:S:E` quando a obra é episódica.
pub(super) fn entry_meta_query(entry: &HarvestEntry, deadline: i64) -> MetaQuery {
    let id = match (entry.season, entry.episode) {
        (Some(season), Some(episode)) => {
            format!("{}:{season}:{episode}", entry.imdb_id)
        }
        _ => entry.imdb_id.clone(),
    };
    MetaQuery {
        encoded: entry.imdb_id.clone(),
        kind: entry.media_type.as_str().to_string(),
        id,
        // O colhedor não paga multiobra/data doméstica: a query é a canônica
        // e a régua usa o que já estiver em cache.
        include_multiwork: false,
        include_home_release: false,
        deadline_at_ms: Some(deadline),
    }
}

/// Campos que a régua lê — MESMA conversão do coletor nativo
/// (`jackett_live::relevance_entries`).
pub(super) fn relevance_items(items: &[JackettRawItem]) -> Vec<RelevanceItem> {
    items
        .iter()
        .map(|item| RelevanceItem {
            title: Some(item.title.clone()),
            title_pascal: None,
            magnet: item.magnet.clone(),
            magnet_uri: None,
            guid: None,
            is_br: item.is_br,
        })
        .collect()
}
