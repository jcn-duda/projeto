//! Fixtures compartilhadas dos testes da reserva do banco. Um unico `base()`
//! evita que os modulos irmaos montem o mesmo cenario com defaults divergentes.

use std::collections::{BTreeMap, HashSet};

use super::{
    FallbackInput, FallbackMagnet, FallbackSource, FallbackWork, WorkTarget, GLOBAL_MAX,
    PER_INDEXER_MAX,
};

pub(super) fn magnet(
    hash: &str,
    title: &str,
    seeders_max: i64,
    seeders_last: i64,
) -> FallbackMagnet {
    FallbackMagnet {
        hash: hash.to_string(),
        uri: format!("magnet:?xt=urn:btih:{hash}&dn={title}"),
        title: title.to_string(),
        size: 1024,
        is_br: false,
        dubbed: false,
        quality: "1080p".to_string(),
        seeders_max,
        seeders_last,
        last_seen: 1,
        lied: false,
    }
}

pub(super) fn work(
    hash: &str,
    passed_filter: i64,
    last_seen: i64,
    magnet: FallbackMagnet,
) -> FallbackWork {
    FallbackWork {
        hash: hash.to_string(),
        passed_filter,
        last_seen,
        magnet: Some(magnet),
    }
}

pub(super) fn source(indexer: &str, last_seen: i64) -> FallbackSource {
    FallbackSource {
        indexer: indexer.to_string(),
        tracker: String::new(),
        last_seen,
        allowed: true,
    }
}

pub(super) fn base() -> FallbackInput {
    FallbackInput {
        enabled: true,
        fallback_enabled: true,
        imdb_id: "tt0133093".to_string(),
        work_target: WorkTarget {
            season: None,
            episode: None,
        },
        live_hashes: HashSet::new(),
        failed: HashSet::new(),
        suspect: HashSet::new(),
        all_failed: false,
        per_indexer_max: PER_INDEXER_MAX,
        global_max: GLOBAL_MAX,
        br_indexers: Vec::new(),
        index_only_indexers: Vec::new(),
        works: Vec::new(),
        sources: BTreeMap::new(),
    }
}

pub(super) fn sources(entries: &[(&str, &[&str])]) -> BTreeMap<String, Vec<FallbackSource>> {
    entries
        .iter()
        .map(|(hash, indexers)| {
            (
                hash.to_string(),
                indexers.iter().map(|id| source(id, 1)).collect(),
            )
        })
        .collect()
}

pub(super) fn set(values: &[&str]) -> HashSet<String> {
    values.iter().map(|s| s.to_string()).collect()
}
