//! Implementação das traits de I/O nativo do índice (`F4.5`) sobre os stores
//! SQLite. O `adom-search` define as traits para não depender deste crate; o
//! `adom-server` injeta os stores no orquestrador — índice e banco são sempre
//! nativos desde o R4.

use adom_core::{BankRow, InstantSource, InstantWork, WorkTarget};
use adom_search::orchestrator::{
    BankFilterCtx, IndexedReleaseWire, MagnetBankSource, ReleaseIndexSource,
};
use adom_search::ReleaseEntry;
use serde_json::Value;

use crate::magnet_bank::{MagnetBankStore, WorkCtx};
use adom_index::{IndexedRelease, RecordOptions, ReleaseIndexStore};

fn work_target(season: Option<i64>, episode: Option<i64>) -> WorkTarget {
    WorkTarget { season, episode }
}

fn wire(release: IndexedRelease) -> IndexedReleaseWire {
    IndexedReleaseWire {
        hash: release.hash,
        title: release.title,
        size: release.size,
        indexer: release.indexer,
        tracker: release.tracker,
        is_br: release.is_br,
        dubbed: release.dubbed,
        quality: release.quality,
        seeders: release.seeders,
        seen_at: release.seen_at,
        lied: release.lied,
        source: release.source,
        media_source: release.media_source,
    }
}

/// Fonte do orquestrador sobre o índice nativo. Newtype porque a trait é do
/// adom-search e o `ReleaseIndexStore` agora mora no adom-index (regra de órfã).
pub struct NativeReleaseIndex(ReleaseIndexStore);

impl NativeReleaseIndex {
    pub fn from_env() -> Result<Self, String> {
        ReleaseIndexStore::from_env().map(Self)
    }

    /// Store já aberto (memória ou arquivo) — o colhedor de teste injeta.
    pub fn from_store(store: ReleaseIndexStore) -> Self {
        Self(store)
    }

    pub fn with_limits(self, ttl_seconds: u64, max_releases: usize) -> Self {
        Self(self.0.with_limits(ttl_seconds, max_releases))
    }
}

impl ReleaseIndexSource for NativeReleaseIndex {
    fn lookup(
        &self,
        imdb: &str,
        season: Option<i64>,
        episode: Option<i64>,
        now_ms: i64,
    ) -> Vec<IndexedReleaseWire> {
        ReleaseIndexStore::lookup(&self.0, imdb, work_target(season, episode), now_ms)
            .into_iter()
            .map(wire)
            .collect()
    }

    fn is_partial(
        &self,
        imdb: &str,
        season: Option<i64>,
        episode: Option<i64>,
        now_ms: i64,
    ) -> bool {
        ReleaseIndexStore::is_partial(&self.0, imdb, work_target(season, episode), now_ms)
    }

    fn record(
        &self,
        entry: &ReleaseEntry,
        now_ms: i64,
        bank: Option<adom_search::orchestrator::BankLookup<'_>>,
    ) -> Result<usize, String> {
        ReleaseIndexStore::record(
            &self.0,
            &entry.imdb,
            work_target(entry.season, entry.episode),
            &entry.items,
            RecordOptions {
                partial: false,
                keep_partial: false,
                source: entry.source.as_deref(),
                supplemental: entry.supplemental,
            },
            self.0.ttl(),
            self.0.max_releases(),
            now_ms,
            bank,
        )
    }
}

impl MagnetBankSource for MagnetBankStore {
    fn works_for_obra_many(
        &self,
        imdb: &str,
        targets: &[WorkTarget],
        limit_per_target: usize,
        max_total: usize,
        indexers: Option<&[String]>,
    ) -> Vec<InstantWork> {
        MagnetBankStore::works_for_obra_many(
            self,
            imdb,
            targets,
            limit_per_target,
            max_total,
            indexers,
        )
        .unwrap_or_default()
    }

    fn sources_for_many(
        &self,
        hashes: &[String],
    ) -> std::collections::BTreeMap<String, Vec<InstantSource>> {
        MagnetBankStore::sources_for_many(self, hashes).unwrap_or_default()
    }

    fn bank_rows_many(&self, hashes: &[String]) -> Vec<BankRow> {
        MagnetBankStore::bank_rows_many(self, hashes).unwrap_or_default()
    }

    fn mark_filter_outcome(
        &self,
        entered: &[Value],
        survivors: &[Value],
        ctx: &BankFilterCtx,
        now_ms: i64,
    ) -> bool {
        self.mark_filter_outcome(
            entered,
            survivors,
            &WorkCtx {
                imdb_id: ctx.imdb_id.clone(),
                season: ctx.season,
                episode: ctx.episode,
            },
            now_ms,
        )
    }

    fn has_br_row(&self, imdb: &str, targets: &[WorkTarget]) -> bool {
        MagnetBankStore::has_br_row(self, imdb, targets)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adom_index::ReleaseIndexStore;
    use serde_json::json;

    const NOW: i64 = 1_700_000_000_000;
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    impl NativeReleaseIndex {
        fn memory() -> Self {
            Self(ReleaseIndexStore::open_memory().expect("memória"))
        }
    }

    fn entry(supplemental: bool, source: Option<&str>) -> ReleaseEntry {
        ReleaseEntry {
            imdb: "tt0111161".into(),
            season: None,
            episode: None,
            items: vec![json!({
                "title": "Filme 1994 1080p Dublado",
                "infoHash": HASH,
                "isBr": true,
            })],
            entered: None,
            survivors: None,
            source: source.map(str::to_string),
            supplemental,
        }
    }

    #[test]
    fn record_transporta_suplementar_sem_inferir_fonte() {
        let index = NativeReleaseIndex::memory();
        index
            .record(&entry(true, None), NOW, None)
            .expect("suplementar");
        assert!(
            index.is_partial("tt0111161", None, None, NOW),
            "flag chega ao store"
        );

        let outro = NativeReleaseIndex::memory();
        outro
            .record(&entry(false, Some("autofetch")), NOW, None)
            .expect("autofetch");
        assert!(
            !outro.is_partial("tt0111161", None, None, NOW),
            "source/título não viram suplementar"
        );
    }
}
