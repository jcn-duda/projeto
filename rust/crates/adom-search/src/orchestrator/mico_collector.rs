//! Collect nativo via `adom_sources::MicoClient`.
//!
//! Monta sempre que o cliente sobe; falha de boot → log e a fonte fica fora.
//! Mico é card virtual BR (consulta por IMDb): no TS entra como tarefa
//! prioritária junto do BLUDV.
//!
//! - `TaskScope::Nonpriority` → lote vazio (não é fonte global).
//! - `late_sweep` → lote vazio (varredura pt-BR é caminho Jackett).
//! - `Priority` / `All` → `client.search` por IMDb (+ S/E em série); fail-open.
//! - O `live` é **por fonte** (`"mico"`), como no Node: `Ok` = conjuntos
//!   vazios, `Empty` = resposta válida sem item relevante (ou 4xx da obra),
//!   `Failed` = consulta tentada e não respondida, `Pending` = prazo do
//!   coletor venceu antes da resposta (o Node também a teria como pendente).
//!   `all` fica `Unknown` — o agregado só existe no ramo `/all` do Jackett.
//! - O nativo não faz captura no banco, card/status nem efeitos.

use std::future::Future;
use std::pin::Pin;

use adom_core::RelevanceItem;
use adom_sources::{
    MicoClient, MicoMediaType, MicoOutcome, MicoRawItem, MicoSearchArgs, MicoSearchOptions,
};
use serde_json::Value;

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::jackett_collector::process_title_precision_tail_cut;
use crate::orchestrator::jackett_live::relevant_count;
use crate::orchestrator::live_state::LiveBatchState;
use crate::raw_item::{known_size, RawItem};

/// Chave do estado vivo da fonte (uma consulta só, como Prowlarr/Torrentio).
pub const MICO_LIVE_KEY: &str = "mico";

/// Monta o collector Mico. Falha de boot do cliente → `None` + log (a fonte
/// fica fora; o gateway só falha se NENHUMA fonte nativa montar).
pub fn try_mico_collector_from_env() -> Option<MicoCollector> {
    match MicoCollector::from_env() {
        Ok(c) => Some(c),
        Err(err) => {
            eprintln!("[search] Mico nativa indisponível: {err}");
            None
        }
    }
}

/// Collector que fala o addon Mico por IMDb (sem POST `/internal/search/collect`).
pub struct MicoCollector {
    client: MicoClient,
}

impl MicoCollector {
    pub fn new(client: MicoClient) -> Self {
        Self { client }
    }

    pub fn from_env() -> Result<Self, String> {
        Ok(Self::new(MicoClient::from_env()?))
    }

    pub fn client(&self) -> &MicoClient {
        &self.client
    }

    fn search_options(&self, job: &CollectJob) -> MicoSearchOptions {
        MicoSearchOptions {
            // O prazo ABSOLUTO do coletor: vencido antes da resposta, a
            // consulta é `pending` (não falha), como no Node.
            deadline_at: Some(job.deadline_at),
        }
    }
}

impl Collector for MicoCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            // Card virtual no `ji`: sem ele (e sem `MICO_DEFAULT` quando não há
            // `ji`) o Node não consultaria o Mico.
            if !job.wants("mico") {
                return Ok(batch(Vec::new(), LiveBatchState::default(), false));
            }
            // Topologia TS: mico é tarefa BR (`priority=true`); globais e
            // late-sweep não consultam.
            if job.late_sweep || matches!(job.scope, TaskScope::Nonpriority) {
                return Ok(CollectBatch::default());
            }
            let Some(args) = search_args_from_job(&job) else {
                return Ok(batch(Vec::new(), live_ok(), false));
            };
            let outcome = self
                .client
                .search_outcome(&args, self.search_options(&job))
                .await;
            let label = outcome.label();
            match outcome {
                MicoOutcome::Ok(items) => {
                    let live = live_from_items(&items, &job);
                    let mapped = items.into_iter().map(raw_from_mico).collect();
                    Ok(batch(mapped, live, false))
                }
                // Configuração (kill-switch / base barrada / args incompletos):
                // a fonte nem foi consultada — nada foi prometido.
                MicoOutcome::Disabled | MicoOutcome::BlockedUrl | MicoOutcome::NoEndpoint => {
                    Ok(batch(Vec::new(), live_ok(), false))
                }
                // Prazo do coletor vencido: o Node também teria a consulta em
                // voo (`pending`) e o lote parcial.
                MicoOutcome::Pending => {
                    eprintln!("[search] mico: {label} (sem resposta no prazo)");
                    Ok(batch(Vec::new(), live_pending(), true))
                }
                // 4xx da obra: o host está vivo (o Node não alimenta o
                // breaker) e a resposta válida sem item é vazio suspeito.
                MicoOutcome::Http(status) if status < 500 && status != 429 => {
                    eprintln!("[search] mico: {label} (obra sem release)");
                    Ok(batch(Vec::new(), live_empty_or_ok(&job), false))
                }
                // 429/5xx, JSON inválido, rede, timeout e breaker aberto: a
                // consulta foi prometida e não foi respondida.
                failure => {
                    debug_assert!(failure.is_host_failure() || failure == MicoOutcome::BreakerOpen);
                    eprintln!("[search] mico: {label} (falha viva, lote vazio)");
                    Ok(batch(Vec::new(), live_failed(), false))
                }
            }
        })
    }
}

/// Monta os args do cliente; `None` = obra incompleta (sem rede).
fn search_args_from_job(job: &CollectJob) -> Option<MicoSearchArgs> {
    let media_type = MicoMediaType::parse(&job.kind)?;
    if job.imdb_id.is_empty() {
        return None;
    }
    let (season, episode) = match media_type {
        MicoMediaType::Movie => (None, None),
        MicoMediaType::Series => {
            let season = i32_of(job.season)?;
            let episode = i32_of(job.episode)?;
            (Some(season), Some(episode))
        }
    };
    Some(MicoSearchArgs {
        media_type,
        imdb_id: job.imdb_id.clone(),
        season,
        episode,
        year: year_of(job.year.as_ref()),
    })
}

fn i32_of(n: Option<i64>) -> Option<i32> {
    n.and_then(|v| i32::try_from(v).ok())
}

fn year_of(year: Option<&Value>) -> Option<i32> {
    let v = year?;
    if let Some(n) = v.as_i64() {
        return i32::try_from(n).ok();
    }
    if let Some(n) = v.as_u64() {
        return i32::try_from(n).ok();
    }
    if let Some(s) = v.as_str() {
        let digits: String = s.chars().take(4).filter(|c| c.is_ascii_digit()).collect();
        return digits.parse().ok();
    }
    None
}

/// Estado vivo da fonte: `all` fica `Unknown` (o agregado só existe no ramo
/// `/all` do Jackett). `pending` só aparece quando o PRAZO venceu — nunca é
/// inventado para timeout do cliente.
fn live_state(failed: bool, pending: bool, empty: bool) -> LiveBatchState {
    let mut state = LiveBatchState::default();
    if failed {
        state.failed.insert(MICO_LIVE_KEY.to_string());
    }
    if pending {
        state.pending.insert(MICO_LIVE_KEY.to_string());
    }
    if empty {
        state.empty.insert(MICO_LIVE_KEY.to_string());
    }
    state
}

fn live_ok() -> LiveBatchState {
    LiveBatchState::default()
}

fn live_empty() -> LiveBatchState {
    live_state(false, false, true)
}

fn live_failed() -> LiveBatchState {
    live_state(true, false, false)
}

fn live_pending() -> LiveBatchState {
    live_state(false, true, false)
}

/// 4xx da obra: `Empty` só quando o Node mediria `relevant: 0` (tem nomes);
/// sem `matchContext.names` o Node não marca vazio suspeito.
fn live_empty_or_ok(job: &CollectJob) -> LiveBatchState {
    if job.names.is_empty() {
        live_ok()
    } else {
        live_empty()
    }
}

/// Resposta válida é `Ok` quando ALGUM item passa na relevância da obra;
/// resposta sem item relevante é `Empty` (vazio suspeito), como `relevant:0`.
/// A régua é a MESMA do Jackett/Prowlarr (`filter_relevant_raw`); sem nomes o
/// Node não mede `relevant` (`undefined`) e não há vazio.
fn live_from_items(items: &[MicoRawItem], job: &CollectJob) -> LiveBatchState {
    if job.names.is_empty() {
        return live_ok();
    }
    if items.is_empty() {
        return live_empty();
    }
    let entries: Vec<RelevanceItem> = items
        .iter()
        .map(|item| RelevanceItem {
            title: Some(item.title.clone()),
            title_pascal: None,
            // O item do Mico tem magnet (sem `dn=`) e `isBr` já no cru.
            magnet: Some(item.magnet.clone()),
            magnet_uri: None,
            guid: None,
            is_br: item.is_br,
        })
        .collect();
    if relevant_count(&entries, job, process_title_precision_tail_cut()) == 0 {
        live_empty()
    } else {
        live_ok()
    }
}

fn batch(items: Vec<RawItem>, live: LiveBatchState, partial: bool) -> CollectBatch {
    CollectBatch {
        items,
        partial,
        live: Some(live),
    }
}

fn raw_from_mico(item: MicoRawItem) -> RawItem {
    let magnet = item.magnet.trim();
    RawItem {
        title: Some(item.title).filter(|t| !t.is_empty()),
        magnet: Some(magnet.to_string()).filter(|m| !m.is_empty()),
        info_hash: Some(item.info_hash).filter(|h| !h.is_empty()),
        seeders: Some(item.seeders),
        // Mesma régua do caminho Node (`raw_item_from_value`): 1 KB sentinela
        // de fonte BR não vira 💾.
        size_bytes: known_size(item.size),
        indexer: Some(item.indexer).filter(|s| !s.is_empty()),
        sources: Vec::new(),
        is_br: item.is_br,
        ..RawItem::default()
    }
}

#[cfg(test)]
#[path = "mico_collector_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "mico_collector_live_support.rs"]
mod live_support;

#[cfg(test)]
#[path = "mico_collector_live_tests.rs"]
mod live_tests;
