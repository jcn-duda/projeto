//! Leitura NATIVA do índice/banco para a via rápida do `/stream` (R4).
//!
//! Substituiu a rota Node de leitura do índice (removida no R4): lookup do
//! `idx:v14`, via
//! instantânea do `magnets.db`, itens da conta e o follow-up do índice.
//! A ORDEM e as MARCAS são as do TS:
//!
//! - instantânea → `fromFallback` (📦/~N) nos itens do acervo;
//! - índice → `fromSnapshot` (a foto também exibe 📦 até a promoção tardia);
//! - conta → `fromAccount`;
//! - resposta instantânea = acervo + índice + conta; resposta do índice coberto
//!   = índice (SEM selo — o `idxReleasesToRaw` do TS não marca) + conta.
//!
//! O follow-up roda em TODA busca, como na rota do Node, e é emitido por
//! `/internal/search/effects` (fire-and-forget).

use std::collections::HashSet;
use std::time::Duration;

use adom_core::{
    filter_relevant_raw, idx_pool_covered, instant_window, pool_covered, select_instant,
    InstantInput, InstantItem, InstantMeta, PoolCoverageItem, RelevanceItem, RelevanceQuery,
    RelevanceSettings, WorkRow,
};
use serde_json::{json, Map, Value};

use crate::raw_item::RawItem;

use super::account::{account_raw_items, AccountRequest};
use super::finish::{bool_of, str_of, SearchInput};
use super::index_effects::{effect_entries, follow_up_plan, FollowUpPlan};
use super::index_metrics as metrics;
use super::index_source::{
    allowed_source_indexer, bank_limits, bank_read_window, obra_targets, IndexedReleaseWire,
};
use super::meta::SearchMeta;
use super::respond::now_ms;
use super::tail::EffectsBatch;
use super::Orchestrator;

/// Resultado da leitura nativa. Os itens das três fontes ficam SEPARADOS para a
/// via rápida escolher as marcas de cada conjunto.
#[derive(Clone, Debug, Default)]
pub(super) struct NativeIndexOutcome {
    pub indexed: Vec<IndexedReleaseWire>,
    pub is_partial: bool,
    pub index_covered: bool,
    pub instant_eligible: bool,
    pub index_items: Vec<RawItem>,
    pub instant_items: Vec<RawItem>,
    pub account_items: Vec<RawItem>,
    pub follow_up: FollowUpPlan,
}

impl NativeIndexOutcome {
    fn has_any(&self) -> bool {
        self.instant_eligible || self.index_covered
    }
}

impl Orchestrator {
    /// Via rápida nativa. `None` = nem instantânea nem índice coberto (a coleta
    /// ao vivo segue); o follow-up ainda é emitido, como no Node.
    pub(super) async fn native_fast_path(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
    ) -> Option<super::fast_path::FastPath> {
        let outcome = self.native_index_scan(input, meta).await;
        self.emit_index_follow_up(input, meta, &outcome).await;
        if outcome.instant_eligible {
            let mut items: Vec<RawItem> = outcome.instant_items.clone();
            items.extend(outcome.index_items.iter().cloned());
            items.extend(outcome.account_items.iter().cloned());
            return Some(super::fast_path::FastPath {
                instant: true,
                items,
            });
        }
        if outcome.index_covered {
            // Via do índice NÃO-instantânea: o `idxReleasesToRaw` do TS não põe
            // marca nenhuma, então `fromSnapshot` é NEUTRALIZADO.
            let mut items: Vec<RawItem> = outcome
                .index_items
                .iter()
                .cloned()
                .map(|mut item| {
                    item.from_snapshot = false;
                    item
                })
                .collect();
            items.extend(outcome.account_items.iter().cloned());
            return Some(super::fast_path::FastPath {
                instant: false,
                items,
            });
        }
        let _ = outcome.has_any();
        None
    }

    /// Follow-up: decisão do índice + POST fire-and-forget dos efeitos.
    async fn emit_index_follow_up(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
        outcome: &NativeIndexOutcome,
    ) {
        if !self.config.release_index_enabled {
            return;
        }
        let effects = effect_entries(
            &outcome.follow_up,
            &meta.imdb_id,
            &input.kind,
            meta.season,
            meta.episode,
        );
        if effects.is_empty() {
            return;
        }
        metrics::global_metrics().inc(metrics::EFFECTS, effects.len() as u64);
        let tail = self.tail.clone();
        let encoded = crate::request::encoded_for_internal(input.encoded.as_deref());
        tokio::spawn(async move {
            if let Err(err) = tail.effects(EffectsBatch { encoded, effects }).await {
                eprintln!("[search] effects do índice falharam: {err}");
            }
        });
    }

    /// Leitura + decisão (sem emitir nada).
    pub(super) async fn native_index_scan(
        &self,
        input: &SearchInput,
        meta: &SearchMeta,
    ) -> NativeIndexOutcome {
        let now = now_ms();
        let mut outcome = NativeIndexOutcome::default();
        let enabled = self.config.release_index_enabled && self.config.release_index_ttl > 0;
        let mut covered = false;
        let mut autofetch_seeded = false;
        if let Some(index) = self.index.as_ref() {
            if enabled {
                metrics::global_metrics().inc(metrics::LOOKUP, 1);
                let extracted = index.lookup(&meta.imdb_id, meta.season, meta.episode, now);
                outcome.indexed = extracted
                    .into_iter()
                    .filter(|release| {
                        release.source.as_deref() == Some("autofetch")
                            || allowed_source_indexer(
                                &release.indexer,
                                &input.options,
                                &self.config.index_only_indexers,
                                &self.config.selected_indexers,
                            )
                    })
                    .collect();
                outcome.is_partial = !outcome.indexed.is_empty()
                    && index.is_partial(&meta.imdb_id, meta.season, meta.episode, now);
                let coverage_items: Vec<PoolCoverageItem> =
                    outcome.indexed.iter().map(release_to_coverage).collect();
                covered = !outcome.indexed.is_empty()
                    && !outcome.is_partial
                    && idx_pool_covered(
                        &coverage_items,
                        meta.season,
                        meta.episode,
                        self.config.auto_fetch_min_seeders,
                    )
                    .covered;
                autofetch_seeded = outcome
                    .indexed
                    .iter()
                    .any(|release| release.source.as_deref() == Some("autofetch"));
                outcome.index_covered = !outcome.is_partial && (covered || autofetch_seeded);
                outcome.index_items = outcome
                    .indexed
                    .iter()
                    .map(|release| release_to_raw(release, true))
                    .collect();
            }
        } else {
            metrics::global_metrics().inc(metrics::SOURCE_MISSING, 1);
            eprintln!("[search] idx:v14 indisponível; seguindo sem índice nativo");
        }

        // Via instantânea (banco), antes do fast-path do índice. Independe do
        // `idx:v14`: só o `magnets.db` aberto já responde a via rápida.
        let indexed_snapshot = outcome.indexed.clone();
        self.fill_instant(
            &input.options,
            &input.kind,
            meta,
            now,
            &indexed_snapshot,
            &mut outcome,
        );

        // Follow-up: o mesmo critério da rota Node, inclusive para obra fora do
        // índice (miss/gap). O acervo só é lido quando o índice não prova BR.
        let bank = self.bank.clone();
        let targets = obra_targets(&input.kind, meta.season, meta.episode);
        outcome.follow_up = follow_up_plan(
            &outcome.indexed,
            outcome.is_partial,
            covered,
            autofetch_seeded,
            !self.config.index_only_indexers.is_empty(),
            || {
                bank.as_ref()
                    .is_some_and(|bank| bank.has_br_row(&meta.imdb_id, &targets))
            },
        );
        self.count_index_metrics(&outcome, covered);

        outcome.account_items = self.native_account_items(input, meta).await;
        outcome
    }

    fn count_index_metrics(&self, outcome: &NativeIndexOutcome, covered: bool) {
        let m = metrics::global_metrics();
        let plan = &outcome.follow_up;
        if plan.miss {
            m.inc(metrics::MISS, 1);
        }
        if plan.hit {
            m.inc(metrics::HIT, 1);
        }
        if plan.partial {
            m.inc(metrics::PARTIAL, 1);
        }
        if plan.gap {
            m.inc(metrics::GAP, 1);
        }
        if plan.served {
            m.inc(metrics::BR_GAP_SERVED, 1);
        }
        if plan.br_gap {
            m.inc(metrics::BR_GAP, 1);
            if plan.upgrade {
                m.inc(metrics::BR_GAP_UPGRADE, 1);
            }
            if plan.bank_evidence {
                m.inc(metrics::BR_GAP_BANK_EVIDENCE, 1);
            }
            if plan.no_evidence {
                m.inc(metrics::BR_GAP_NO_EVIDENCE, 1);
            }
        }
        if outcome.index_covered {
            m.inc(metrics::SERVED, outcome.index_items.len() as u64);
        }
        let _ = covered;
    }

    /// `collectInstantItems`: janela adaptativa, seleção, filtro e cobertura.
    fn fill_instant(
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
    async fn native_account_items(&self, input: &SearchInput, meta: &SearchMeta) -> Vec<RawItem> {
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

/// Releases do índice → pseudo-item de cobertura (`PoolCoverageItem`).
fn release_to_coverage(release: &IndexedReleaseWire) -> PoolCoverageItem {
    PoolCoverageItem {
        title: Some(release.title.clone()),
        quality: Some(release.quality.clone()),
        seeders: Some(json!(release.seeders)),
        hash: Some(release.hash.clone()),
        is_br: release.is_br,
        dubbed: Some(Some(release.dubbed)),
        source: release.source.clone(),
        ..PoolCoverageItem::default()
    }
}

/// Item instantâneo → pseudo-item de cobertura.
fn instant_to_coverage(item: &InstantItem) -> PoolCoverageItem {
    PoolCoverageItem {
        title: Some(item.title.clone()),
        quality: Some(item.quality.clone()),
        seeders: Some(json!(item.seeders)),
        hash: Some(item.info_hash.clone()),
        magnet: item.magnet.clone(),
        is_br: item.is_br,
        dubbed: Some(Some(item.dubbed)),
        ..PoolCoverageItem::default()
    }
}

/// `idxReleasesToRaw` do TS: sem marca (o chamador põe `fromSnapshot`).
fn release_to_raw(release: &IndexedReleaseWire, from_snapshot: bool) -> RawItem {
    let mut extra = Map::new();
    extra.insert("dubbed".to_string(), release.dubbed.into());
    if !release.quality.is_empty() {
        extra.insert("quality".to_string(), release.quality.clone().into());
    }
    if let Some(source) = &release.source {
        extra.insert("indexSource".to_string(), source.clone().into());
    }
    RawItem {
        title: Some(release.title.clone()),
        info_hash: Some(release.hash.clone()),
        seeders: Some(release.seeders as f64),
        size_bytes: release.size.map(|size| size as f64),
        indexer: Some(release.indexer.clone()),
        tracker: release
            .tracker
            .clone()
            .or_else(|| Some(release.indexer.clone())),
        is_br: release.is_br,
        from_snapshot,
        lied: release.lied,
        media_source: release.media_source.clone(),
        extra,
        ..RawItem::default()
    }
}

/// `toRawItem` da via instantânea: selo 📦 + flags que o build lê
/// (`dubbed`/`quality`/`fallbackFetchable`).
fn instant_to_raw(item: &InstantItem) -> RawItem {
    let mut extra = Map::new();
    extra.insert("dubbed".to_string(), item.dubbed.into());
    if !item.quality.is_empty() {
        extra.insert("quality".to_string(), item.quality.clone().into());
    }
    if item.fallback_fetchable {
        extra.insert("fallbackFetchable".to_string(), true.into());
    }
    RawItem {
        title: Some(item.title.clone()),
        info_hash: Some(item.info_hash.clone()),
        magnet: item.magnet.clone(),
        seeders: Some(item.seeders as f64),
        size_bytes: item.size.map(|size| size as f64),
        indexer: Some(item.indexer.clone()),
        tracker: (!item.tracker.is_empty()).then(|| item.tracker.clone()),
        is_br: item.is_br,
        from_fallback: true,
        extra,
        ..RawItem::default()
    }
}

/// Um `FollowUpKind` isolado (diagnóstico/teste).
#[cfg(test)]
pub(super) fn follow_up_count(
    plan: &FollowUpPlan,
    kind: super::index_effects::FollowUpKind,
) -> usize {
    plan.actions
        .iter()
        .filter(|action| **action == kind)
        .count()
}

#[cfg(test)]
#[path = "native_index_tests.rs"]
mod tests;
