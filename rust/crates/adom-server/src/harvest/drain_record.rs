//! Filtro → escrita → delta de Found/transição → invalidação.
//!
//! A régua continua nas origens (`filter_relevant_raw`, `release_entry_for`,
//! `record_release`). Aqui só se confirma o índice e se pede a invalidação
//! da obra na mesma instância de `StreamsStore` do gateway.

use std::collections::HashSet;
use std::sync::Arc;

use adom_core::{
    filter_relevant_raw, probe_found_viable, route_work_location, BrGapRelease, BrProbeRelease,
    BrTransition, RelevanceQuery, RelevanceSettings, WorkTarget, BR_GAP_TARGET_QUALITY,
};
use adom_harvest::{DrainOutcome, HarvestEntry, HarvestMediaType, HarvestStore, OutboxItem};
use adom_search::orchestrator::harvest_support::{record_release, release_entry_for};
use adom_search::orchestrator::{IndexedReleaseWire, RawItem, ReleaseIndexSource, SharedBank};
use adom_store::StreamsStore;

use super::drain_shape::relevance_items;
use super::drain_sources::dedupe_by_hash;

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
    /// Journal/outbox da execução; `None` = drain sem journal (teste).
    pub journal: Option<&'a HarvestStore>,
    /// Execução corrente (`begin_run` do loop); vazia sem journal.
    pub run_id: &'a str,
}

pub(super) struct RecordedDrain {
    pub outcome: DrainOutcome,
    pub found: bool,
}

pub(super) fn record_collected(args: RecordArgs<'_>) -> RecordedDrain {
    let season = args.entry.season.map(i64::from);
    let episode = args.entry.episode.map(i64::from);
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
    let survivors = dedupe_by_hash(
        kept.iter()
            .filter_map(|index| entered.get(*index).cloned())
            .collect(),
    );
    let dests = write_destinations(args.entry, &survivors);
    let before = lookup_dests(args.index, &args.entry.imdb_id, &dests, args.now_ms);
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
            // Passo `index` só depois da escrita confirmada; erro do journal
            // nunca derruba o drain.
            note_step(args.journal, args.run_id, "index", args.now_ms);
            let after = lookup_dests(args.index, &args.entry.imdb_id, &dests, args.now_ms);
            let found = before
                .iter()
                .zip(&after)
                .any(|(prev, next)| found_from_index(prev, next));
            let transition = before
                .iter()
                .zip(&after)
                .map(|(prev, next)| br_transition_from(prev, next))
                .find(|step| !matches!(step, BrTransition::None))
                .unwrap_or(BrTransition::None);
            apply_transition(
                args.streams,
                args.pending_invalidate,
                &args.entry.imdb_id,
                transition,
                args.journal,
                args.run_id,
                args.now_ms,
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
                    // A verdade do corte vive no `drain.rs` (que reescreve a
                    // flag no desfecho real); aqui só há falha de gravação.
                    truncated: false,
                },
                found: false,
            }
        }
    }
}

pub(super) fn retry_invalidations(
    streams: Option<&Arc<StreamsStore>>,
    pending: &mut HashSet<String>,
    journal: Option<&HarvestStore>,
    now_ms: i64,
) {
    let Some(store) = streams else {
        return;
    };
    let waiting: Vec<String> = pending.iter().cloned().collect();
    for imdb in waiting {
        match store.invalidate_for_obra(&imdb) {
            Ok(_) => {
                // Retentativa bem-sucedida fecha o MESMO alvo que o drain
                // abriu na outbox: as duas vias convergem.
                ack_outbox_target(journal, &imdb, now_ms);
                pending.remove(&imdb);
            }
            Err(err) => {
                eprintln!("[harvest] invalidação pendente de {imdb} falhou: {err}");
            }
        }
    }
}

/// Destinos reais da escrita: a chave da entrada e cada roteamento de survivor.
fn write_destinations(entry: &HarvestEntry, items: &[RawItem]) -> Vec<(Option<i64>, Option<i64>)> {
    let request = WorkTarget {
        season: entry.season.map(i64::from),
        episode: entry.episode.map(i64::from),
    };
    let mut dests = vec![(request.season, request.episode)];
    for item in items {
        let dn = item.dn();
        let routed = route_work_location(
            request,
            item.title_text(),
            (!dn.is_empty()).then_some(dn.as_str()),
        );
        let dest = (routed.season, routed.episode);
        if !dests.contains(&dest) {
            dests.push(dest);
        }
    }
    dests
}

fn lookup_dests(
    index: &dyn ReleaseIndexSource,
    imdb: &str,
    dests: &[(Option<i64>, Option<i64>)],
    now_ms: i64,
) -> Vec<Vec<IndexedReleaseWire>> {
    dests
        .iter()
        .map(|(season, episode)| index.lookup(imdb, *season, *episode, now_ms))
        .collect()
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

/// Invalida a lista da obra em `streams` e move o alvo na outbox.
///
/// A outbox recebe o alvo ANTES da tentativa: o `pending` em memória morre com
/// o processo, e um crash entre a escrita do índice e a invalidação perdia o
/// alvo para sempre. Com o alvo durável, o próximo boot ainda invalida.
fn apply_transition(
    streams: Option<&Arc<StreamsStore>>,
    pending: &mut HashSet<String>,
    imdb: &str,
    transition: BrTransition,
    journal: Option<&HarvestStore>,
    run_id: &str,
    now_ms: i64,
) {
    if matches!(transition, BrTransition::None) {
        return;
    }
    let Some(store) = streams else {
        eprintln!("[harvest] {imdb}: store de streams ausente; invalidação degradada");
        return;
    };
    if let Some(journal) = journal {
        let target = obra_target(imdb);
        if let Err(err) = journal.outbox_push(&target, now_ms) {
            eprintln!("[harvest] journal: outbox não registrou {target}: {err}");
        }
    }
    match store.invalidate_for_obra(imdb) {
        Ok(_) => {
            // Invalidação aplicada: o alvo sai da outbox e o passo fica no
            // journal da execução.
            ack_outbox_target(journal, imdb, now_ms);
            note_step(journal, run_id, "invalidated", now_ms);
            pending.remove(&imdb.to_ascii_lowercase());
        }
        Err(err) => {
            // O alvo FICA na outbox (sem ack) e a retentativa em memória
            // continua valendo para o ciclo corrente.
            eprintln!("[harvest] {imdb}: invalidação falhou: {err}");
            pending.insert(imdb.to_ascii_lowercase());
        }
    }
}

/// Alvo de invalidação da outbox: a obra, não a config de `/stream`.
fn obra_target(imdb: &str) -> String {
    format!("obra:{imdb}")
}

/// Passo no journal do run aberto.
///
/// Run vazio = drain sem `begin_run` (teste, ou loop que não abriu o run):
/// no-op em vez de gravar um `harvest:v1:run:` órfão. Erro de journal nunca
/// derruba o drain, que é quem alimenta o índice.
fn note_step(journal: Option<&HarvestStore>, run_id: &str, step: &str, now_ms: i64) {
    if run_id.is_empty() {
        return;
    }
    let Some(journal) = journal else {
        return;
    };
    if let Err(err) = journal.journal_step(run_id, step, now_ms) {
        eprintln!("[harvest] journal: passo {step} nao gravou: {err}");
    }
}

/// Fecha o alvo na outbox (idempotente; sem journal é no-op).
fn ack_outbox_target(journal: Option<&HarvestStore>, imdb: &str, now_ms: i64) {
    let Some(journal) = journal else {
        return;
    };
    let target = obra_target(imdb);
    let batch = [OutboxItem {
        target: target.clone(),
        at_ms: now_ms,
        tries: 0,
    }];
    if let Err(err) = journal.outbox_ack(&batch, now_ms) {
        eprintln!("[harvest] journal: ack de {target} não gravou: {err}");
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
