//! Collect nativo via `adom_sources::ProwlarrClient`.
//!
//! Monta sempre que o cliente sobe; falha de boot → log e a fonte fica fora.
//! Espelha o padrão do [`super::JackettCollector`], sem plano Torznab/BR/breaker
//! — o Prowlarr do TS (`prowlarr.search(query)`) é uma única consulta global.
//!
//! - `TaskScope::Priority` → lote vazio (não é fonte BR).
//! - `late_sweep` → lote vazio (varredura pt-BR é caminho Jackett; sem
//!   `ignore_breaker` aqui).
//! - `All` / `Nonpriority` → `client.search_outcome(job.query)`; fail-open.
//!
//! **Identidade** é a do Node: o item do Prowlarr NÃO tem `indexer` no TS, só
//! `tracker` (`indexer || indexerId`), e o `_indexer` do stream nasce dele
//! (`search-names.ts:250`). Fixar `indexer = "prowlarr"` movia a cota por
//! indexador e o ⚙️ do chip para uma fonte que o Node não conhece.
//!
//! **Live (F2.2)** é por FONTE (`"prowlarr"`), como o Mico no Node — não por
//! tracker: o Prowlarr agrega os indexers numa consulta só e não publica quais
//! responderam. `Ok` = conjuntos vazios; `Empty` = resposta válida sem item
//! relevante; `Failed` = consulta tentada e não respondida (HTTP/rede/JSON/
//! timeout). `pending` nunca é inventado e `all` fica `Unknown`: o agregado
//! `error` é do ramo `/all` do Jackett, não daqui.
//!
//! Fora desta fatia: cache `raw:v1`.

use std::future::Future;
use std::pin::Pin;

use adom_core::RelevanceItem;
use adom_sources::{ProwlarrClient, ProwlarrOutcome, ProwlarrRawItem};

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::jackett_collector::process_title_precision_tail_cut;
use crate::orchestrator::jackett_live::relevant_count;
use crate::orchestrator::live_state::LiveBatchState;
use crate::raw_item::RawItem;

/// Chave do estado vivo da fonte. O Prowlarr é UMA consulta (como o Mico):
/// não há como atribuir falha/vazio a um tracker específico sem inventar.
pub const PROWLARR_LIVE_KEY: &str = "prowlarr";

/// Monta o collector Prowlarr. Falha de boot do cliente → `None` + log (a fonte
/// fica fora; o gateway só falha se NENHUMA fonte nativa montar).
pub fn try_prowlarr_collector_from_env() -> Option<ProwlarrCollector> {
    match ProwlarrCollector::from_env() {
        Ok(c) => Some(c),
        Err(err) => {
            eprintln!("[search] Prowlarr nativa indisponível: {err}");
            None
        }
    }
}

/// Collector que fala `/api/v1/search` direto (sem POST `/internal/search/collect`).
pub struct ProwlarrCollector {
    client: ProwlarrClient,
}

impl ProwlarrCollector {
    pub fn new(client: ProwlarrClient) -> Self {
        Self { client }
    }

    pub fn from_env() -> Result<Self, String> {
        Ok(Self::new(ProwlarrClient::from_env()?))
    }

    pub fn client(&self) -> &ProwlarrClient {
        &self.client
    }
}

/// Estado vivo da fonte: `all` fica `Unknown` (o agregado só existe no ramo
/// `/all` do Jackett) e `pending` nunca é criado.
fn live_state(failed: bool, empty: bool) -> LiveBatchState {
    let mut state = LiveBatchState::default();
    if failed {
        state.failed.insert(PROWLARR_LIVE_KEY.to_string());
    }
    if empty {
        state.empty.insert(PROWLARR_LIVE_KEY.to_string());
    }
    state
}

fn live_ok() -> LiveBatchState {
    live_state(false, false)
}

fn live_empty() -> LiveBatchState {
    live_state(false, true)
}

fn live_failed() -> LiveBatchState {
    live_state(true, false)
}

/// Resposta válida é `Ok` quando ALGUM item passa na relevância da obra;
/// resposta sem item relevante é `Empty` (vazio suspeito), como o
/// `relevant: 0` do Node. A régua é a MESMA do Jackett (`filter_relevant_raw`).
fn live_from_items(items: &[ProwlarrRawItem], job: &CollectJob) -> LiveBatchState {
    if items.is_empty() {
        return live_empty();
    }
    let entries: Vec<RelevanceItem> = items
        .iter()
        .map(|item| RelevanceItem {
            title: Some(item.title.clone()),
            title_pascal: None,
            magnet: item.magnet.clone(),
            magnet_uri: None,
            guid: None,
            // O Prowlarr do Node não marca `isBr`: origem BR vem do título no
            // build. A relevância lê o mesmo que o `mapResults` leria aqui.
            is_br: false,
        })
        .collect();
    let relevant = relevant_count(&entries, job, process_title_precision_tail_cut());
    if relevant == 0 {
        live_empty()
    } else {
        live_ok()
    }
}

fn batch(items: Vec<RawItem>, live: LiveBatchState) -> CollectBatch {
    CollectBatch {
        items,
        partial: false,
        live: Some(live),
    }
}

impl Collector for ProwlarrCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            // Fonte fora dos `providers` da request: o Node não a consultaria.
            // Nada foi prometido → live vazio (nunca falha sintética).
            if !job.wants("prowlarr") {
                return Ok(batch(Vec::new(), live_ok()));
            }
            // Mesma topologia do TS: prowlarr entra como tarefa global
            // (`priority=false`); scope BR e late-sweep não consultam.
            if job.late_sweep || matches!(job.scope, TaskScope::Priority) {
                return Ok(batch(Vec::new(), live_ok()));
            }
            if job.query.is_empty() {
                return Ok(batch(Vec::new(), live_ok()));
            }
            let outcome = self.client.search_outcome(&job.query).await;
            let label = outcome.label();
            match outcome {
                ProwlarrOutcome::Ok(items) => {
                    let live = live_from_items(&items, &job);
                    let mapped = items.into_iter().map(raw_from_prowlarr).collect();
                    Ok(batch(mapped, live))
                }
                // Configuração do operador (sem chave / URL barrada): a fonte
                // nem foi consultada. Não vira falha viva — o Node também não
                // registra nada nesse caso (`search` devolve `[]`).
                ProwlarrOutcome::Disabled | ProwlarrOutcome::BlockedUrl => {
                    Ok(batch(Vec::new(), live_ok()))
                }
                failure => {
                    debug_assert!(failure.is_consult_failure());
                    eprintln!("[search] prowlarr: {label} (falha viva, lote vazio)");
                    Ok(batch(Vec::new(), live_failed()))
                }
            }
        })
    }
}

fn raw_from_prowlarr(item: ProwlarrRawItem) -> RawItem {
    // Identidade do Node: `_indexer = String(item.indexer || tracker || '')`.
    // O item do Prowlarr só publica `tracker`; ele é o id E o rótulo.
    let tracker = item
        .tracker
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let sources = tracker
        .map(|t| vec![format!("tracker:{t}")])
        .unwrap_or_default();
    RawItem {
        title: Some(item.title).filter(|t| !t.is_empty()),
        magnet: item.magnet,
        info_hash: item.info_hash,
        seeders: item.seeders,
        size_bytes: item.size,
        indexer: tracker.map(str::to_string),
        tracker: tracker.map(str::to_string),
        sources,
        // `prowlarr.ts` não preenche `isBr`; `looksPtBr(title)` decide no build.
        is_br: false,
        ..RawItem::default()
    }
}

#[cfg(test)]
#[path = "prowlarr_collector_tests.rs"]
mod tests;
