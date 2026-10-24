//! Filtro → escrita → delta de Found/transição → invalidação.
//!
//! A régua continua nas origens (`filter_relevant_raw`, `release_entry_for`,
//! `record_release`). Aqui só se confirma o índice e se pede a invalidação
//! da obra na mesma instância de `StreamsStore` do gateway.

use std::collections::HashSet;
use std::sync::Arc;

use adom_core::{
    filter_relevant_raw, probe_found_viable, BrGapRelease, BrProbeRelease, BrTransition,
    RelevanceQuery, RelevanceSettings, BR_GAP_TARGET_QUALITY,
};
use adom_harvest::{DrainOutcome, HarvestEntry, HarvestMediaType};
use adom_search::orchestrator::harvest_support::{record_release, release_entry_for};
use adom_search::orchestrator::{IndexedReleaseWire, RawItem, ReleaseIndexSource, SharedBank};
use adom_store::StreamsStore;

use super::drain_shape::relevance_items;

pub(super) struct RecordArgs<'a> {
    pub index: &'a dyn ReleaseIndexSource,
    pub bank: Option<&'a SharedBank>,
    pub streams: Option<&'a Arc<StreamsStore>>,
    pub pending_invalidate: &'a mut HashSet<String>,
    pub entry: &'a HarvestEntry,
    pub items: Vec<RawItem>,
    pub attempted: u32,
    pub jackett_complete: bool,
    pub settings: RelevanceSettings,
    pub names: &'a [String],
    pub year: &'a str,
    pub alt_year: Option<&'a str>,
    pub multi_work_root: Option<&'a str>,
    pub home_release_at: Option<i64>,
    pub now_ms: i64,
}

pub(super) struct RecordedDrain {
    pub outcome: DrainOutcome,
    pub found: bool,
}

pub(super) fn record_collected(args: RecordArgs<'_>) -> RecordedDrain {
    let season = args.entry.season.map(i64::from);
    let episode = args.entry.episode.map(i64::from);
    let before = args
        .index
        .lookup(&args.entry.imdb_id, season, episode, args.now_ms);
    let relevance = relevance_items(&args.items);
    let query = RelevanceQuery {
        names: args.names,
        year: args.year,
        alt_year: args.alt_year,
        is_series: args.entry.media_type == HarvestMediaType::Series,
        season,
        episode,
        multi_work_root: args.multi_work_root,
        home_release_at: args.home_release_at,
    };
    let kept = filter_relevant_raw(&relevance, &query, &args.settings).kept;
    let entered = args.items;
    let survivors: Vec<RawItem> = kept
        .iter()
        .filter_map(|index| entered.get(*index).cloned())
        .collect();
    let mut release = release_entry_for(
        &args.entry.imdb_id,
        args.entry.media_type.as_str(),
        season,
        episode,
        Some(args.year).filter(|year| !year.is_empty()),
        &entered,
        &survivors,
    );
    release.supplemental = args.entry.br_probe || !args.jackett_complete;
    match record_release(
        args.index,
        &release,
        args.bank.map(|bank| bank.as_ref()),
        args.now_ms,
    ) {
        Ok(written) => {
            eprintln!(
                "[harvest] {} {}: {} release(s) no índice ({} consulta(s))",
                args.entry.imdb_id,
                args.entry.media_type.as_str(),
                written,
                args.attempted
            );
            let after = args
                .index
                .lookup(&args.entry.imdb_id, season, episode, args.now_ms);
            let found = found_from_index(&before, &after);
            apply_transition(
                args.streams,
                args.pending_invalidate,
                &args.entry.imdb_id,
                br_transition_from(&before, &after),
            );
            RecordedDrain {
                outcome: DrainOutcome::ok_with_queries(args.attempted),
                found,
            }
        }
        Err(err) => {
            eprintln!(
                "[harvest] {}: gravação no índice falhou: {err}",
                args.entry.imdb_id
            );
            RecordedDrain {
                outcome: DrainOutcome {
                    ok: false,
                    queries: args.attempted,
                },
                found: false,
            }
        }
    }
}

pub(super) fn retry_invalidations(
    streams: Option<&Arc<StreamsStore>>,
    pending: &mut HashSet<String>,
) {
    let Some(store) = streams else {
        return;
    };
    let waiting: Vec<String> = pending.iter().cloned().collect();
    for imdb in waiting {
        match store.invalidate_for_obra(&imdb) {
            Ok(_) => {
                pending.remove(&imdb);
            }
            Err(err) => {
                eprintln!("[harvest] invalidação pendente de {imdb} falhou: {err}");
            }
        }
    }
}

fn found_from_index(before: &[IndexedReleaseWire], after: &[IndexedReleaseWire]) -> bool {
    let before_probe: Vec<BrProbeRelease<'_>> = before.iter().map(probe_from_wire).collect();
    let after_probe: Vec<BrProbeRelease<'_>> = after.iter().map(probe_from_wire).collect();
    let before_gap: Vec<BrGapRelease<'_>> = before.iter().map(gap_from_wire).collect();
    let require = has_br_before(&before_gap).then_some(BR_GAP_TARGET_QUALITY);
    probe_found_viable(&before_probe, &after_probe, require)
}

fn br_transition_from(before: &[IndexedReleaseWire], after: &[IndexedReleaseWire]) -> BrTransition {
    let before_gap: Vec<BrGapRelease<'_>> = before.iter().map(gap_from_wire).collect();
    let after_gap: Vec<BrGapRelease<'_>> = after.iter().map(gap_from_wire).collect();
    adom_core::br_transition(&before_gap, &after_gap)
}

fn apply_transition(
    streams: Option<&Arc<StreamsStore>>,
    pending: &mut HashSet<String>,
    imdb: &str,
    transition: BrTransition,
) {
    if matches!(transition, BrTransition::None) {
        return;
    }
    let Some(store) = streams else {
        eprintln!("[harvest] {imdb}: store de streams ausente; invalidação degradada");
        return;
    };
    match store.invalidate_for_obra(imdb) {
        Ok(_) => {
            pending.remove(&imdb.to_ascii_lowercase());
        }
        Err(err) => {
            eprintln!("[harvest] {imdb}: invalidação falhou: {err}");
            pending.insert(imdb.to_ascii_lowercase());
        }
    }
}

fn has_br_before(before: &[BrGapRelease<'_>]) -> bool {
    adom_core::has_br_dubbed(before)
}

fn gap_from_wire(release: &IndexedReleaseWire) -> BrGapRelease<'_> {
    BrGapRelease {
        source: release.source.as_deref(),
        is_br: release.is_br,
        dubbed: release.dubbed,
        lied: release.lied,
        quality: release.quality.as_str(),
    }
}

fn probe_from_wire(release: &IndexedReleaseWire) -> BrProbeRelease<'_> {
    BrProbeRelease {
        hash: release.hash.as_str(),
        seeders: release.seeders as f64,
        release: gap_from_wire(release),
    }
}

#[cfg(test)]
#[path = "drain_record_tests.rs"]
mod tests;
