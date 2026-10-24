//! Via instantanea e conta: leitura do banco, selecao e filtro.

use std::collections::HashSet;
use std::time::Duration;

use adom_core::{
    filter_relevant_raw, idx_pool_covered, instant_window, pool_covered, select_instant,
    InstantInput, InstantItem, InstantMeta, PoolCoverageItem, RelevanceItem, RelevanceQuery,
    RelevanceSettings, WorkRow,
};
use serde_json::Value;

use crate::raw_item::RawItem;

use super::account::{account_raw_items, AccountRequest};
use super::finish::{bool_of, str_of, SearchInput};
use super::index_metrics as metrics;
use super::index_source::{
    allowed_source_indexer, bank_limits, bank_read_window, obra_targets, IndexedReleaseWire,
};
use super::meta::SearchMeta;
use super::native_index::NativeIndexOutcome;
use super::native_index_wire::{instant_to_coverage, instant_to_raw, release_to_coverage};
use super::respond::now_ms;
use super::Orchestrator;

impl Orchestrator {
    /// `collectInstantItems`: janela adaptativa, seleção, filtro e cobertura.
    pub(super) fn fill_instant(
        &self,
        options: &Value,
        type_: &str,
        meta: &SearchMeta,
        now: i64,
        indexed: &[IndexedReleaseWire],
        outcome: &mut NativeIndexOutcome,
    ) {
        if !self.config.magnet_bank_enabled {
            return;
        }
        let Some(bank) = self.bank.as_ref() else {
            metrics::global_metrics().inc(metrics::SOURCE_MISSING, 1);
            eprintln!("[search] magnets.db indisponível; seguindo sem instantânea");
            return;
        };
        if !self.config.magnet_bank_instant_enabled {
            metrics::global_metrics().inc(metrics::INSTANT_SKIP_DISABLED, 1);
            return;
        }
        let m = metrics::global_metrics();
        let (per_indexer, global) = bank_limits(
            self.config.magnet_bank_fallback_max_per_indexer,
            self.config.magnet_bank_fallback_global_max,
        );
        let (read_limit, max_total) = bank_read_window(per_indexer, global);
        let targets = obra_targets(type_, meta.season, meta.episode);
        let rows = bank.works_for_obra_many(&meta.imdb_id, &targets, read_limit, max_total, None);
        let works: Vec<Option<WorkRow>> = rows
            .iter()
            .map(|row| {
                Some(WorkRow {
                    passed_filter: row.passed_filter,
                    last_seen: row.last_seen,
                    first_seen: row.first_seen,
                })
            })
            .collect();
        let year = meta.year_text();
        let instant_meta = InstantMeta {
            year: &year,
            released: meta.released.as_deref().unwrap_or(""),
            first_aired: meta.first_aired.as_deref().unwrap_or(""),
        };
        let window = instant_window(
            &works,
            &instant_meta,
            now,
            self.config.magnet_bank_instant_min_ms,
            self.config.magnet_bank_instant_max_ms,
            self.config.magnet_bank_instant_fresh_max_ms,
        );
        if window.last_collection == 0 {
            m.inc(metrics::INSTANT_SKIP_NO_LIVE, 1);
            return;
        }
        if now - window.last_collection > window.window_ms {
            m.inc(metrics::INSTANT_SKIP_STALE, 1);
            return;
        }
        let hashes: Vec<String> = rows.iter().map(|row| row.hash.clone()).collect();
        let mut sources = bank.sources_for_many(&hashes);
        let index_only = &self.config.index_only_indexers;
        for list in sources.values_mut() {
            for source in list.iter_mut() {
                source.allowed = allowed_source_indexer(
                    &source.indexer,
                    options,
                    index_only,
                    &self.config.selected_indexers,
                );
            }
        }
        let mut exclude = HashSet::new();
        for release in indexed {
            if let Some(hash) = adom_core::extract_info_hash(&release.hash) {
                exclude.insert(hash.to_lowercase());
            }
        }
        let selection = select_instant(&InstantInput {
            works: rows,
            sources,
            exclude_hashes: exclude,
            index_only_indexers: self.config.index_only_indexers.clone(),
            prefer_dubbed: bool_of(options, "preferDubbed"),
            per_indexer_max: per_indexer,
            global_max: global,
        });
        if selection.idx_hash_skipped > 0 {
            m.inc(
                metrics::INSTANT_SKIP_IDX_HASH,
                selection.idx_hash_skipped as u64,
            );
        }
        if selection.items.is_empty() {
            m.inc(metrics::INSTANT_SKIP_NO_LIVE, 1);
            return;
        }
        let filtered = self.filter_instant_items(selection.items, options, meta, now);
        if filtered.is_empty() {
            m.inc(metrics::INSTANT_SKIP_NO_LIVE, 1);
            return;
        }
        // Cobertura do pool: itens JÁ CORTADOS + releases do índice.
        let mut coverage: Vec<PoolCoverageItem> =
            filtered.iter().map(instant_to_coverage).collect();
        coverage.extend(indexed.iter().map(release_to_coverage));
        if !idx_pool_covered(
            &coverage,
            meta.season,
            meta.episode,
            self.config.auto_fetch_min_seeders,
        )
        .covered
        {
            m.inc(metrics::INSTANT_SKIP_NOT_COVERED, 1);
            return;
        }
        // Sem dublado não trava mais a via (o tail segue buscando).
        if bool_of(options, "preferDubbed")
            && !pool_covered(
                &coverage,
                meta.season,
                true,
                self.config.auto_fetch_min_seeders,
            )
        {
            m.inc(metrics::INSTANT_SKIP_NO_DUBBED, 1);
        }
        m.inc(metrics::INSTANT, 1);
        outcome.instant_eligible = true;
        outcome.instant_items = filtered.iter().map(instant_to_raw).collect();
    }

    fn filter_instant_items(
        &self,
        items: Vec<InstantItem>,
        _options: &Value,
        meta: &SearchMeta,
        now: i64,
    ) -> Vec<InstantItem> {
        // Sem nomes o filtro do TS é no-op (`names=[]`).
        if meta.names.is_empty() {
            return items;
        }
        let relevance: Vec<RelevanceItem> = items
            .iter()
            .map(|item| RelevanceItem {
                title: Some(item.title.clone()),
                magnet: item.magnet.clone(),
                is_br: item.is_br,
                ..RelevanceItem::default()
            })
            .collect();
        let year = meta.year_text();
        let query = RelevanceQuery {
            names: &meta.names,
            year: &year,
            alt_year: meta.alt_year.as_deref(),
            is_series: meta.season.is_some(),
            season: meta.season,
            episode: meta.episode,
            multi_work_root: meta.multi_work_root.as_deref(),
            home_release_at: meta.home_release_at,
        };
        let settings = self.relevance_settings(now);
        let outcome = filter_relevant_raw(&relevance, &query, &settings);
        outcome
            .kept
            .iter()
            .map(|index| items[*index].clone())
            .collect()
    }

    pub(super) fn relevance_settings(&self, now_ms: i64) -> RelevanceSettings {
        RelevanceSettings {
            now_ms,
            pre_home_release_cut: self.config.build.pre_home_release_cut,
            pre_home_release_margin_ms: self.config.build.pre_home_release_margin_ms,
            title_precision_tail_cut: self.config.build.title_precision_tail_cut,
        }
    }

    /// Itens da conta com o MESMO teto curto do TS (`accountFastPath.waitMs`).
    pub(super) async fn native_account_items(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
    ) -> Vec<RawItem> {
        if !self.config.account_fast_path || !self.config.account_inventory_source {
            return Vec::new();
        }
        let Some(source) = self.account.clone() else {
            return Vec::new();
        };
        let req = AccountRequest {
            service: str_of(&input.options, "debridService"),
            api_key: str_of(&input.options, "debridApiKey"),
        };
        if !req.is_active() || !adom_debrid::account::is_known_service(&req.service) {
            return Vec::new();
        }
        let wait = self.config.account_fast_wait_ms.max(1) as u64;
        let label = adom_debrid::account::label_of(&req.service).to_string();
        match tokio::time::timeout(Duration::from_millis(wait), source.inventory(req)).await {
            Ok(Ok(inventory)) if !inventory.is_unusable() => {
                let settings = self.relevance_settings(now_ms());
                account_raw_items(&inventory.items, meta, settings, &label)
            }
            Ok(Ok(_)) => Vec::new(),
            Ok(Err(err)) => {
                eprintln!("[search] conta do índice indisponível: {err}");
                Vec::new()
            }
            Err(_) => Vec::new(),
        }
    }
}
