//! Consultas do drain: Jackett (obrigatório) e BLUDV (só FULL).
//!
//! Não decide matching. As duas fontes viram [`RawItem`] antes do filtro
//! conjunto. Custo BLUDV não entra no contador Jackett; BLUDV nunca certifica
//! `jackett_complete`. `fromAccount` nunca entra.

use std::collections::HashSet;
use std::time::Duration;

use adom_harvest::HarvestEntry;
use adom_search::orchestrator::harvest_support::{raw_items_from_bludv, raw_items_from_jackett};
use adom_search::orchestrator::{RawItem, SearchMeta};
use adom_sources::{
    shape_search_query, BludvClient, BludvOutcome, BludvSearchOpts, JackettClient,
    JackettMediaType, SearchOptions,
};

use super::drain::NetworkDrain;

/// Lote cru já convertido + débito só das consultas Jackett.
pub(super) struct SourceBatch {
    pub items: Vec<RawItem>,
    pub attempted: u32,
    pub answered: u32,
}

/// Desfecho da escrita após as fontes (tabela 2.7). `ok` só quando Jackett
/// respondeu; BLUDV útil sem Jackett grava suplemento e o drain continua falho.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SourcePlan {
    FailNoWrite,
    OkNoWrite,
    Write { ok: bool },
}

pub(super) fn source_plan(answered: u32, has_items: bool) -> SourcePlan {
    match (answered > 0, has_items) {
        (false, false) => SourcePlan::FailNoWrite,
        (false, true) => SourcePlan::Write { ok: false },
        (true, false) => SourcePlan::OkNoWrite,
        (true, true) => SourcePlan::Write { ok: true },
    }
}

/// Query PT não vazia; senão a EN. Sites BR indexam pelo título em português.
pub(super) fn bludv_query(search: &SearchMeta) -> &str {
    search
        .pt_query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(search.query.trim())
}

/// Jackett primeiro; BLUDV depois. Mesmo hash NÃO some aqui: o filtro
/// decide qual título vale, e só então [`dedupe_by_hash`] fica com a
/// primeira sobrevivente (Jackett, se as duas passarem).
/// `fromAccount` sai das duas pontas — o índice nunca o recebe.
pub(super) fn merge_source_items(jackett: Vec<RawItem>, bludv: Vec<RawItem>) -> Vec<RawItem> {
    jackett
        .into_iter()
        .chain(bludv)
        .filter(|item| !item.from_account)
        .collect()
}

/// Primeira ocorrência do hash sobrevive. Hash vazio não colapsa linhas.
pub(super) fn dedupe_by_hash(items: Vec<RawItem>) -> Vec<RawItem> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let hash = item.hash();
        if !hash.is_empty() && !seen.insert(hash) {
            continue;
        }
        out.push(item);
    }
    out
}

/// Só FULL consulta BLUDV. Sonda e cliente ausente = zero chamadas.
pub(super) async fn collect_bludv(
    client: Option<&BludvClient>,
    entry: &HarvestEntry,
    search: &SearchMeta,
) -> Vec<RawItem> {
    if entry.br_probe {
        return Vec::new();
    }
    let Some(client) = client else {
        return Vec::new();
    };
    match client
        .search_outcome(bludv_query(search), &BludvSearchOpts { dubbed_only: false })
        .await
    {
        BludvOutcome::Ok(items) => {
            if !items.is_empty() {
                eprintln!("[harvest] BLUDV: {} item(ns)", items.len());
            }
            raw_items_from_bludv(items)
                .into_iter()
                .filter(|item| !item.from_account)
                .collect()
        }
        BludvOutcome::Disabled => Vec::new(),
        other => {
            eprintln!("[harvest] BLUDV: {}", other.label());
            Vec::new()
        }
    }
}

impl NetworkDrain {
    /// Jackett (débito) e, só em FULL, BLUDV. Ordem: Jackett → BLUDV.
    pub(super) async fn search(
        &self,
        jackett: &JackettClient,
        entry: &HarvestEntry,
        search: &SearchMeta,
    ) -> SourceBatch {
        let jackett_batch = self.search_jackett(jackett, entry, search).await;
        let bludv = collect_bludv(self.bludv.as_ref(), entry, search).await;
        SourceBatch {
            items: merge_source_items(jackett_batch.items, bludv),
            attempted: jackett_batch.attempted,
            answered: jackett_batch.answered,
        }
    }

    async fn search_jackett(
        &self,
        jackett: &JackettClient,
        entry: &HarvestEntry,
        search: &SearchMeta,
    ) -> SourceBatch {
        let media = JackettMediaType::parse(entry.media_type.as_str());
        // Sonda dirigida: SÓ a interseção index-only∩pt-BR (~3 consultas).
        // Interseção vazia não vira `/all`: a sonda não tem alvo.
        let targets_source: Vec<String> = if entry.br_probe {
            let probe = self.probe_targets();
            if probe.is_empty() {
                return SourceBatch {
                    items: Vec::new(),
                    attempted: 0,
                    answered: 0,
                };
            }
            probe
        } else {
            self.settings.indexers.clone()
        };
        let targets: Vec<Option<&str>> = if targets_source.is_empty() {
            vec![None]
        } else {
            targets_source.iter().map(|id| Some(id.as_str())).collect()
        };
        let mut items = Vec::new();
        let mut attempted = 0u32;
        let mut answered = 0u32;
        for (position, target) in targets.iter().enumerate() {
            if position > 0 && self.settings.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.settings.delay_ms)).await;
            }
            let id = target.unwrap_or(adom_sources::ALL_QUERY_INDEXER);
            let indexers: Vec<String> = target.map(|id| vec![id.to_string()]).unwrap_or_default();
            let options = self.options_for(id, search);
            let outcomes = jackett
                .search_outcomes(&search.query, media, &indexers, &options)
                .await;
            attempted = attempted.saturating_add(1);
            let mut target_ok = false;
            for outcome in outcomes {
                if outcome.source_ok {
                    target_ok = true;
                }
                items.extend(outcome.items);
            }
            if target_ok {
                answered = answered.saturating_add(1);
            }
        }
        SourceBatch {
            items: raw_items_from_jackett(items),
            attempted,
            answered,
        }
    }

    fn options_for(&self, indexer: &str, search: &SearchMeta) -> SearchOptions {
        let is_br = self.jackett_config.is_br(indexer);
        let bare = self.jackett_config.is_bare_title(indexer);
        let shaped = shape_search_query(indexer, &search.query, is_br, bare);
        let fallback = search
            .pt_query
            .as_ref()
            .filter(|pt| shape_search_query(indexer, pt, is_br, bare) != shaped);
        let original = search
            .original_query
            .as_ref()
            .filter(|orig| shape_search_query(indexer, orig, is_br, bare) != shaped);
        let index_only = self.settings.index_only.iter().any(|id| id == indexer);
        SearchOptions {
            record_status: Some(false),
            ignore_breaker: false,
            skip_resolve: false,
            timeout_ms: index_only.then_some(self.settings.index_only_timeout_ms),
            fallback_query: fallback.cloned(),
            original_query: original.cloned(),
            ..SearchOptions::default()
        }
    }
}

#[cfg(test)]
#[path = "drain_sources_tests.rs"]
mod tests;
