//! Conversões puras do drain (sem rede): env dos isentos da busca viva, o id
//! do `MetaQuery` e os campos que a régua lê.
//!
//! Ficam fora de `drain.rs` só para a catraca de linhas; nenhuma régua nova
//! nasce aqui.

use adom_core::RelevanceItem;
use adom_harvest::HarvestEntry;
use adom_search::orchestrator::{MetaQuery, RawItem};

/// Default do Node para `JACKETT_LIVE_EXEMPT_INDEXERS` (o `adom-search` guarda
/// o dele em `pub(super)`; aqui a lista é só para o subset da sonda).
pub(crate) const DEFAULT_LIVE_EXEMPT: &str = "apachetorrent-cardigann";

/// Default do Node para `JACKETT_INDEX_ONLY_INDEXERS` (`src/config/jackett.ts`).
pub(crate) const DEFAULT_INDEX_ONLY: &str = "redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann,magnetdownload,1337x,kickasstorrents-ws";

/// `JACKETT_INDEX_ONLY_INDEXERS` do processo — a fonte que a sonda do worker
/// consulta (o `OrchestratorConfig` não existe quando o worker nasce).
pub(crate) fn index_only_indexers() -> Vec<String> {
    split_ids("JACKETT_INDEX_ONLY_INDEXERS", DEFAULT_INDEX_ONLY)
}

/// `JACKETT_LIVE_EXEMPT_INDEXERS` do processo (env presente manda, mesmo
/// vazia; ausente = default do Node).
pub(crate) fn live_exempt_indexers() -> Vec<String> {
    match std::env::var("JACKETT_LIVE_EXEMPT_INDEXERS") {
        Ok(raw) => split_ids_value(&raw),
        Err(_) => vec![DEFAULT_LIVE_EXEMPT.to_string()],
    }
}

fn split_ids(key: &str, default: &str) -> Vec<String> {
    match std::env::var(key) {
        Ok(raw) => split_ids_value(&raw),
        Err(_) => split_ids_value(default),
    }
}

fn split_ids_value(raw: &str) -> Vec<String> {
    let ids: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect();
    // Rename dos ids aposentados (mesmo mapa do TS): a env é a MESMA que o
    // Node lê, então os dois lados precisam casar o mesmo id.
    adom_core::rename_indexer_ids(&ids)
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
/// (`jackett_live::relevance_entries`). Jackett e BLUDV já chegaram como
/// [`RawItem`]; o item Jackett convertido preserva título/magnet/`is_br`.
pub(super) fn relevance_items(items: &[RawItem]) -> Vec<RelevanceItem> {
    items
        .iter()
        .map(|item| RelevanceItem {
            title: item.title.clone(),
            title_pascal: item.title_pascal.clone(),
            magnet: item.magnet.clone(),
            magnet_uri: item.magnet_uri.clone(),
            guid: item.guid.clone(),
            is_br: item.is_br,
        })
        .collect()
}

/// Completo só com ≥1 alvo planejado e todos com resposta válida.
/// Não inferir pela soma de itens nem por `answered > 0`.
pub(super) fn jackett_targets_complete(planned: u32, answered: u32) -> bool {
    planned > 0 && answered == planned
}

#[cfg(test)]
mod tests {
    use adom_search::orchestrator::harvest_support::raw_items_from_jackett;
    use adom_sources::JackettRawItem;

    use super::{jackett_targets_complete, relevance_items};

    #[test]
    fn relevance_de_raw_jackett_preserva_campos() {
        let raw = raw_items_from_jackett(vec![JackettRawItem {
            title: "Filme 2024".into(),
            magnet: Some("magnet:?xt=urn:btih:aa".into()),
            info_hash: None,
            seeders: Some(1.0),
            size: Some(1.0),
            published_at: None,
            tracker: None,
            indexer: "bludv".into(),
            download_url: None,
            is_br: true,
        }]);
        let rel = relevance_items(&raw);
        assert_eq!(rel[0].title.as_deref(), Some("Filme 2024"));
        assert_eq!(rel[0].magnet.as_deref(), Some("magnet:?xt=urn:btih:aa"));
        assert!(rel[0].title_pascal.is_none());
        assert!(rel[0].magnet_uri.is_none());
        assert!(rel[0].guid.is_none());
        assert!(rel[0].is_br);
    }

    #[test]
    fn completo_exige_todos_os_alvos() {
        assert!(!jackett_targets_complete(0, 0));
        assert!(!jackett_targets_complete(0, 3));
        assert!(!jackett_targets_complete(3, 0));
        assert!(!jackett_targets_complete(3, 1));
        assert!(!jackett_targets_complete(3, 2));
        assert!(jackett_targets_complete(1, 1));
        assert!(jackett_targets_complete(3, 3));
    }
}
