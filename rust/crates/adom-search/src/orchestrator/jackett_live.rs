//! Conversão do desfecho por indexer do Jackett no `LiveBatchState` do
//! collect (F2.1).
//!
//! Regras do estado vivo, espelhando o `live-indexer-state.ts` do Node:
//!
//! - **Ok** marca `served` e desfaz `empty`/`failed`/`pending` do indexer;
//! - **Empty** é resposta válida sem item RELEVANTE para a obra: entra em
//!   `empty` (vazio suspeito). 200 com itens de outra obra é `Empty`, como o
//!   `relevant:0` do Node;
//! - **Failed** entra em `failed` (motivo não atravessa o fio);
//! - **Pending** entra em `pending` e torna o lote `partial` — reservado a um
//!   não-concluído REAL; timeout individual chega como `Failed`.
//! - Outcome com `record_status:false` (varredura inline/tardia) é IGNORADO:
//!   não pinta indexer nem torna o lote parcial.
//!
//! O agregado `/all` (`*all*`) não publica nome de indexer: só decide `all`
//! (`Ok`/`Pending`/`Error`). Sem nenhum indexer, `all` fica `Unknown`.
//!
//! `all` derivado dos indexers segue a regra de coerência pedida na F2.1:
//! `Ok` com ao menos um `Ok` (ou resposta vazia válida), `Pending` quando há
//! pendente sem `Ok`, `Error` quando TODOS falharam e `Unknown` sem indexers.

use std::collections::BTreeSet;

use adom_core::{filter_relevant_raw, RelevanceItem, RelevanceQuery, RelevanceSettings};
use adom_sources::{IndexerStatus, JackettRawItem, QueryOutcome, ALL_QUERY_INDEXER};
use serde_json::Value;

use crate::orchestrator::collect::CollectJob;
use crate::orchestrator::live_state::{LiveAllState, LiveBatchState};

/// Converte os outcomes de UM collect Jackett em estado vivo + `partial`.
///
/// Sem outcomes (nenhuma consulta planejada), devolve `Unknown` — nunca
/// inventa "todos responderam". A relevância usa os nomes/ano do MESMO
/// [`CollectJob`] (o Node mede `filterRelevantRaw` com o `matchContext`).
pub(crate) fn live_state_from_outcomes(
    outcomes: &[QueryOutcome],
    job: &CollectJob,
    title_precision_tail_cut: bool,
) -> (LiveBatchState, bool) {
    reduce(
        outcomes.iter().filter(|o| o.record_status),
        job,
        title_precision_tail_cut,
    )
}

/// Referência da SOMBRA: o modo shadow marca `record_status:false` só para
/// não registrar breaker/status; a comparação ainda precisa do live, então
/// aqui NÃO se aplica o filtro de `record_status`. Só a consulta PRINCIPAL
/// entra: sweep (inline/tardio) não pode mascarar nem inventar falha.
pub(crate) fn live_state_from_outcomes_shadow(
    outcomes: &[QueryOutcome],
    job: &CollectJob,
    title_precision_tail_cut: bool,
) -> (LiveBatchState, bool) {
    reduce(
        outcomes.iter().filter(|o| o.primary),
        job,
        title_precision_tail_cut,
    )
}

fn reduce<'a>(
    outcomes: impl Iterator<Item = &'a QueryOutcome>,
    job: &CollectJob,
    title_precision_tail_cut: bool,
) -> (LiveBatchState, bool) {
    let mut acc = Accumulator::default();
    for outcome in outcomes {
        acc.note(outcome, job, title_precision_tail_cut);
    }
    let partial = acc.partial;
    (acc.finish(), partial)
}

/// `Ok` só quando ao menos um item passa na relevância da obra; 200 com
/// itens de outra obra vira `Empty` (vazio suspeito), como `relevant:0`.
fn effective_status(
    outcome: &QueryOutcome,
    job: &CollectJob,
    title_precision_tail_cut: bool,
) -> IndexerStatus {
    if outcome.status != IndexerStatus::Ok || job.names.is_empty() {
        return outcome.status;
    }
    if relevant_items(&outcome.items, job, title_precision_tail_cut) > 0 {
        IndexerStatus::Ok
    } else {
        IndexerStatus::Empty
    }
}

fn relevant_items(
    items: &[JackettRawItem],
    job: &CollectJob,
    title_precision_tail_cut: bool,
) -> usize {
    relevant_count(&relevance_entries(items), job, title_precision_tail_cut)
}

/// Campos que a régua de relevância lê, a partir do lote cru do Jackett.
fn relevance_entries(items: &[JackettRawItem]) -> Vec<RelevanceItem> {
    items
        .iter()
        .map(|item| RelevanceItem {
            title: Some(item.title.clone()),
            title_pascal: None,
            magnet: item.magnet.clone(),
            magnet_uri: None,
            guid: None,
            is_br: item.is_br,
        })
        .collect()
}

/// Quantos itens passam na relevância da obra. Sem `names` o Node não mede
/// `relevant` (`undefined`): todo item conta como resposta útil. Compartilhado
/// com o coletor Prowlarr para medir `empty` com a MESMA régua
/// (`filter_relevant_raw`) em vez de inventar "vazio".
pub(crate) fn relevant_count(
    entries: &[RelevanceItem],
    job: &CollectJob,
    title_precision_tail_cut: bool,
) -> usize {
    if job.names.is_empty() {
        return entries.len();
    }
    let year = job
        .year
        .as_ref()
        .map(|value| match value {
            Value::String(text) => text.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let query = RelevanceQuery {
        names: &job.names,
        year: &year,
        alt_year: None,
        // Mesma régua do Node no collect: `isSeries = season != null`.
        is_series: job.season.is_some(),
        season: job.season,
        episode: job.episode,
        multi_work_root: None,
        home_release_at: None,
    };
    // `home_release_at` é None aqui (o collect nativo ainda não carrega a
    // data doméstica), então o corte pré-lançamento não dispara. O
    // `title_precision_tail_cut` vem do collector (`TITLE_PRECISION_TAIL_CUT`
    // do processo; default true, como no Node).
    let settings = RelevanceSettings {
        now_ms: adom_sources::now_ms(),
        pre_home_release_cut: false,
        pre_home_release_margin_ms: 0,
        title_precision_tail_cut,
    };
    filter_relevant_raw(entries, &query, &settings).kept.len()
}

#[derive(Default)]
struct Accumulator {
    failed: BTreeSet<String>,
    pending: BTreeSet<String>,
    empty: BTreeSet<String>,
    /// Respondeu com ao menos um item (desfaz o vazio suspeito).
    served: BTreeSet<String>,
    /// `true` quando o ramo agregado `/all` participou.
    has_all: bool,
    all: LiveAllState,
    /// `true` quando há ao menos um indexer nomeado.
    has_indexer: bool,
    /// Qualquer consulta não terminou no prazo.
    partial: bool,
}

impl Accumulator {
    fn note(&mut self, outcome: &QueryOutcome, job: &CollectJob, title_precision_tail_cut: bool) {
        let status = effective_status(outcome, job, title_precision_tail_cut);
        if status == IndexerStatus::Pending {
            self.partial = true;
        }
        if outcome.indexer.eq_ignore_ascii_case(ALL_QUERY_INDEXER) {
            self.has_all = true;
            self.all = all_from_status(status);
            return;
        }
        let key = normalize_indexer(&outcome.indexer);
        if key.is_empty() {
            return;
        }
        self.has_indexer = true;
        match status {
            IndexerStatus::Ok => {
                self.served.insert(key.clone());
                self.failed.remove(&key);
                self.pending.remove(&key);
                self.empty.remove(&key);
            }
            IndexerStatus::Empty => {
                self.pending.remove(&key);
                self.failed.remove(&key);
                // Uma resposta com item desta mesma coleta desfaz a suspeita.
                if !self.served.contains(&key) {
                    self.empty.insert(key);
                }
            }
            IndexerStatus::Failed => {
                self.pending.remove(&key);
                self.failed.insert(key);
            }
            IndexerStatus::Pending => {
                // Mesma regra do `noteStart`: falha provada não volta a pender.
                if !self.failed.contains(&key) {
                    self.pending.insert(key);
                }
            }
        }
    }

    fn finish(self) -> LiveBatchState {
        let all = if self.has_all {
            self.all
        } else if !self.has_indexer {
            LiveAllState::Unknown
        } else if !self.served.is_empty() {
            LiveAllState::Ok
        } else if !self.pending.is_empty() {
            LiveAllState::Pending
        } else if !self.empty.is_empty() {
            // Respondeu vazio é resposta válida: o ramo agregado não falhou.
            LiveAllState::Ok
        } else if !self.failed.is_empty() {
            // Todos os indexers falharam.
            LiveAllState::Error
        } else {
            LiveAllState::Unknown
        };
        LiveBatchState {
            failed: self.failed,
            pending: self.pending,
            empty: self.empty,
            all,
        }
    }
}

fn all_from_status(status: IndexerStatus) -> LiveAllState {
    match status {
        IndexerStatus::Ok | IndexerStatus::Empty => LiveAllState::Ok,
        IndexerStatus::Pending => LiveAllState::Pending,
        IndexerStatus::Failed => LiveAllState::Error,
    }
}

/// Mesma normalização das chaves do Node (`trim().toLowerCase()`).
fn normalize_indexer(id: &str) -> String {
    id.trim().to_lowercase()
}
