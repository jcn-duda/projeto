//! O recorder: as três escritas na ordem do TS, com a cerca do passo entre
//! elas e a barreira de persistência antes de avançar.
//!
//! `Ingest::record` é o porte de `createCrawlRecorder().record`
//! (`src/providers/crawl-recorder.ts:159-211`): banco vivo → índice → transição
//! BR + invalidação. A orquestração da PÁGINA (identificação e uma gravação por
//! locação) vive em [`super::page`]; o SQL dos dois bancos, em [`super::store`].

use std::collections::HashSet;

use adom_core::{
    br_transition, filter_relevant_raw, BrGapRelease, BrTransition, RelevanceItem, RelevanceQuery,
    RelevanceSettings, WorkTarget,
};
use adom_search::RawItem;
use adom_store::{IndexedRelease, RecordOptions as IndexRecordOptions, WorkCtx};
use serde_json::Value;

use super::catalog::{ObraCatalog, StreamInvalidator, WorkNames};
use super::locate::raw_items;
use super::store::IngestStore;
use super::{check_abort, CrawlObra, IngestConfig, IngestError, IngestOptions, RecordReport};
use crate::motor::types::CrawlRawItem;

/// `config.search.preHomeReleaseCut` (default `true`). Inerte no crawl: a
/// página não tem data de lançamento doméstico (`home_release_at = None`).
const PRE_HOME_RELEASE_CUT: bool = true;

/// `config.search.preHomeReleaseMarginMs` (default do Node). Inerte no crawl:
/// a página não tem data de lançamento doméstico (`home_release_at = None`), como
/// no `defaultBuildContext` do TS.
const PRE_HOME_RELEASE_MARGIN_MS: i64 = 48 * 60 * 60 * 1000;

/// Recorder + orquestração de página. Genérico nas três costuras para o teste
/// trocar store/catálogo/invalidadores sem rede.
pub struct Ingest<S, C, I> {
    pub(super) store: S,
    pub(super) catalog: C,
    pub(super) invalidator: I,
    config: IngestConfig,
}

impl<S, C, I> Ingest<S, C, I>
where
    S: IngestStore,
    C: ObraCatalog,
    I: StreamInvalidator,
{
    pub fn new(store: S, catalog: C, invalidator: I) -> Self {
        Self {
            store,
            catalog,
            invalidator,
            config: IngestConfig::default(),
        }
    }

    pub fn with_config(store: S, catalog: C, invalidator: I, config: IngestConfig) -> Self {
        Self {
            store,
            catalog,
            invalidator,
            config,
        }
    }

    pub fn config(&self) -> IngestConfig {
        self.config
    }

    /// Porte de `record`: UMA locação, as três escritas na ordem do TS.
    ///
    /// 1. `shouldAbort` → nomes do catálogo → `shouldAbort` (sem nomes é
    ///    [`IngestError::CatalogNoNames`]);
    /// 2. filtro de título estrito com o contexto da obra + locação;
    /// 3. `captureAndMark` (fila cheia → [`IngestError::QueueDropped`]) e
    ///    `flushBarrier` ([`IngestError::FlushFailed`]);
    /// 4. índice com `partial`/`keepPartial` (a raspagem cobre UMA página);
    /// 5. transição BR entre a foto de antes e a de depois → invalidação.
    pub async fn record(
        &self,
        site: &str,
        obra: &CrawlObra,
        releases: &[CrawlRawItem],
        location: WorkTarget,
        options: IngestOptions<'_>,
        now_ms: i64,
    ) -> Result<RecordReport, IngestError> {
        check_abort(&options)?;
        let names = self.names_for(obra).await?;
        // O `buildContext` do TS é seguido por um segundo `checkAbort`.
        check_abort(&options)?;
        let mut invalidated: HashSet<String> = HashSet::new();
        self.write_one(
            site,
            obra,
            &names,
            releases,
            location,
            now_ms,
            &options,
            &mut invalidated,
        )
        .await
    }

    /// Nomes do catálogo — a ÚNICA fonte de contexto do filtro.
    pub(super) async fn names_for(&self, obra: &CrawlObra) -> Result<WorkNames, IngestError> {
        let Some(names) = self.catalog.names(obra).await else {
            return Err(IngestError::CatalogNoNames);
        };
        if names.names.is_empty() {
            return Err(IngestError::CatalogNoNames);
        }
        Ok(names)
    }

    /// UMA locação: filtro → banco vivo → barreira → índice → transição BR.
    /// `invalidated` acumula as obras já invalidadas NESTA página.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn write_one(
        &self,
        site: &str,
        obra: &CrawlObra,
        names: &WorkNames,
        releases: &[CrawlRawItem],
        location: WorkTarget,
        now_ms: i64,
        options: &IngestOptions<'_>,
        invalidated: &mut HashSet<String>,
    ) -> Result<RecordReport, IngestError> {
        // O `record` do TS abre com um `checkAbort` antes de tudo.
        check_abort(options)?;
        let entered = raw_items(site, releases);
        let kept = filter_kept(&entered, obra, names, location, self.config, now_ms);
        check_abort(options)?;

        let ctx = WorkCtx {
            imdb_id: obra.imdb.clone(),
            season: location.season,
            episode: location.episode,
        };
        if !self
            .store
            .capture_and_mark(&entered, &kept, site, &ctx, now_ms)
            .map_err(IngestError::Store)?
        {
            return Err(IngestError::QueueDropped);
        }
        if !self.store.flush() {
            return Err(IngestError::FlushFailed);
        }

        let before = self.store.lookup(&obra.imdb, location, now_ms);
        let partial = self.store.is_partial(&obra.imdb, location, now_ms) || before.is_empty();
        check_abort(options)?;

        let items: Vec<Value> = kept.iter().map(RawItem::to_wire).collect();
        let opts = IndexRecordOptions {
            partial,
            // A raspagem cobre UMA página: nunca rebaixa uma chave completa.
            keep_partial: true,
            source: None,
            supplemental: false,
        };
        let added = self
            .store
            .record(&obra.imdb, location, &items, opts, now_ms)
            .map_err(IngestError::Store)?;
        let after = self.store.lookup(&obra.imdb, location, now_ms);
        let transition = transition_between(&before, &after);
        check_abort(options)?;

        let invalidated =
            if matches!(transition, BrTransition::None) || invalidated.contains(&obra.imdb) {
                false
            } else {
                let done = self.invalidator.invalidate(&obra.imdb).await;
                if done {
                    invalidated.insert(obra.imdb.clone());
                }
                done
            };
        Ok(RecordReport {
            kept: kept.len(),
            added,
            transition,
            invalidated,
        })
    }
}

/// Lê a transição BR das linhas do índice (o `BrGapRelease` é o recorte que a
/// régua pura conhece).
fn gap_releases(releases: &[IndexedRelease]) -> Vec<BrGapRelease<'_>> {
    releases
        .iter()
        .map(|release| BrGapRelease {
            source: release.source.as_deref(),
            is_br: release.is_br,
            dubbed: release.dubbed,
            lied: release.lied,
            quality: release.quality.as_str(),
        })
        .collect()
}

/// `br_transition` entre as duas fotos, com a régua pura do `adom-core`.
fn transition_between(before: &[IndexedRelease], after: &[IndexedRelease]) -> BrTransition {
    br_transition(&gap_releases(before), &gap_releases(after))
}

/// `filterRelevantRaw` com o contexto SÓ do catálogo (nomes + ano resolvido) e
/// a locação da gravação. Devolve os itens na ordem original.
fn filter_kept(
    entered: &[RawItem],
    obra: &CrawlObra,
    names: &WorkNames,
    location: WorkTarget,
    config: IngestConfig,
    now_ms: i64,
) -> Vec<RawItem> {
    let relevance: Vec<RelevanceItem> = entered.iter().map(RawItem::to_relevance).collect();
    let year = names
        .year
        .or(obra.year)
        .map(|value| value.to_string())
        .unwrap_or_default();
    let query = RelevanceQuery {
        names: &names.names,
        year: &year,
        // `defaultBuildContext` do TS não preenche ano dual nem coleção.
        alt_year: None,
        is_series: obra.kind.is_series(),
        season: location.season,
        episode: location.episode,
        multi_work_root: None,
        // A página do crawl não tem data de lançamento doméstico: o corte
        // pré-lançamento fica INERTE (como no TS, que recebe `undefined`).
        home_release_at: None,
    };
    let settings = RelevanceSettings {
        now_ms,
        pre_home_release_cut: PRE_HOME_RELEASE_CUT,
        pre_home_release_margin_ms: PRE_HOME_RELEASE_MARGIN_MS,
        title_precision_tail_cut: config.title_precision_tail_cut,
    };
    filter_relevant_raw(&relevance, &query, &settings)
        .kept
        .into_iter()
        .filter_map(|index| entered.get(index).cloned())
        .collect()
}
