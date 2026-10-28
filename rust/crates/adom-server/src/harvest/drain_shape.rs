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
    index_only_from(std::env::var("JACKETT_INDEX_ONLY_INDEXERS").ok().as_deref())
}

/// Régua da env do index-only: `env || default`, como o
/// `indexerList(process.env.JACKETT_INDEX_ONLY_INDEXERS || '…')` do Node.
///
/// O gate é a string CRUA (`None`/`""` = falsy → default). String VAZIA **não**
/// é kill-switch desta lista; já `"   "` é TRUTHY no Node e o `list()` do TS
/// apara para `[]` — lista vazia, nunca o default. Mesma régua de
/// `stream_config::indexer_list` e de `jackett_collector::env::index_only_from`:
/// antes desta leva, esta porta lia `""` como lista vazia e as outras liam
/// `"   "` como default — com a sonda sem alvo e a busca VIVA excluindo os
/// index-only do default (`no-intersection` silencioso), o mesmo knob com duas
/// regras.
/// Quem aceita vazio como lista vazia é `JACKETT_LIVE_EXEMPT_INDEXERS`
/// (`??` no TS, ver [`live_exempt_indexers`]).
fn index_only_from(raw: Option<&str>) -> Vec<String> {
    match raw {
        None | Some("") => split_ids_value(DEFAULT_INDEX_ONLY),
        Some(value) => split_ids_value(value),
    }
}

/// `JACKETT_LIVE_EXEMPT_INDEXERS` do processo (env presente manda, mesmo
/// vazia; ausente = default do Node).
pub(crate) fn live_exempt_indexers() -> Vec<String> {
    live_exempt_from(
        std::env::var("JACKETT_LIVE_EXEMPT_INDEXERS")
            .ok()
            .as_deref(),
    )
}

/// `??` do Node: env PRESENTE manda, mesmo `''` ou `'   '` — split devolve
/// lista vazia, que é o kill-switch total. Só a AUSÊNCIA cai no default.
fn live_exempt_from(raw: Option<&str>) -> Vec<String> {
    match raw {
        Some(value) => split_ids_value(value),
        None => vec![DEFAULT_LIVE_EXEMPT.to_string()],
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

    use super::{
        index_only_from, jackett_targets_complete, live_exempt_from, relevance_items,
        DEFAULT_INDEX_ONLY, DEFAULT_LIVE_EXEMPT,
    };

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
    fn index_only_env_vazia_cai_no_default_do_node() {
        let default: Vec<String> = DEFAULT_INDEX_ONLY.split(',').map(str::to_string).collect();
        // `env || default` do TS: vazio é FALSY e volta ao default.
        assert_eq!(index_only_from(None), default);
        assert_eq!(index_only_from(Some("")), default);
        // `'   '` é TRUTHY no Node: `indexerList('   ')` devolve lista vazia.
        assert!(index_only_from(Some("   ")).is_empty());
        assert!(index_only_from(Some(" , , ")).is_empty());
        // Presença de valor: split + rename do id aposentado (mesmo do TS).
        assert_eq!(
            index_only_from(Some("apachetorrent,eztv")),
            vec!["apachetorrent-cardigann".to_string(), "eztv".to_string()]
        );
    }

    #[test]
    fn live_exempt_vazio_e_kill_switch() {
        // `??` do Node: só a AUSÊNCIA cai no default.
        assert_eq!(
            live_exempt_from(None),
            vec![DEFAULT_LIVE_EXEMPT.to_string()]
        );
        // Env presente vazia OU só espaços = kill-switch (lista vazia).
        assert!(live_exempt_from(Some("")).is_empty());
        assert!(live_exempt_from(Some("   ")).is_empty());
        assert_eq!(
            live_exempt_from(Some("apachetorrent, eztv")),
            vec!["apachetorrent-cardigann".to_string(), "eztv".to_string()]
        );
    }

    /// Paridade da régua das envs do Jackett com a cópia do `adom-search`
    /// (`orchestrator/jackett_collector_env.rs`) — a MESMA regra em dois crates,
    /// cada lado testando só a sua. Env real não entra: os vetores saem das
    /// funções puras dos dois lados, na ordem `[ausente, "", "   "]`.
    #[test]
    fn regua_das_envs_igual_ao_adom_search() {
        let (index_only_search, live_exempt_search) = adom_search::orchestrator::env_parity_probe();
        // `env || default` do TS: ausente e `""` caem no default; `"   "` é
        // TRUTHY e vira lista VAZIA — nunca o default.
        assert_eq!(
            [
                index_only_from(None),
                index_only_from(Some("")),
                index_only_from(Some("   ")),
            ],
            index_only_search,
            "JACKETT_INDEX_ONLY_INDEXERS divergiu entre adom-server e adom-search"
        );
        // `??` do TS: só a AUSÊNCIA cai no default; `""`/`"   "` são kill-switch.
        assert_eq!(
            [
                live_exempt_from(None),
                live_exempt_from(Some("")),
                live_exempt_from(Some("   ")),
            ],
            live_exempt_search,
            "JACKETT_LIVE_EXEMPT_INDEXERS divergiu entre adom-server e adom-search"
        );
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
