//! Collect nativo via `adom_sources::TorrentioClient`.
//!
//! Monta sempre que o cliente sobe; falha de boot → log e a fonte fica fora.
//! Espelha o padrão do [`super::ProwlarrCollector`]: pool global por IMDb, sem
//! plano Torznab/BR.
//!
//! - `TaskScope::Priority` / `late_sweep` → lote vazio, live sem falha (não é
//!   fonte BR nem varredura pt-BR: nada foi prometido).
//! - `All` / `Nonpriority` → `client.search_outcome` por IMDb (+ S/E em
//!   série); fail-open.
//!
//! **Identidade** é a do Node (`src/providers/torrentio.ts`):
//!
//! - `indexer: "torrentio"` — o agregador, não o tracker interno; é dele que
//!   nasce o `_indexer` do stream (`search-names.ts:250`) e a cota por
//!   indexador;
//! - `tracker` = rótulo depois do ⚙️ no `title` (`ThePirateBay`, `Torrentio`…);
//!   sem a linha de metadados o Node cai no `indexer` — o `display_tracker` do
//!   nativo faz a mesma queda, então `None` aqui reproduz o `⚙️ torrentio`;
//! - título/seeders/hash são do payload, `size` passa pela régua
//!   `known_size` (1 KB sentinela / tamanho implausível = desconhecido), como
//!   o item cru do Node na coleta TS (rota interna removida na R5);
//! - `fileIdx` é PRESERVADO em `RawItem.extra` (o cliente já truncou) e volta
//!   pelo `to_wire`; não é consumido no play/HMAC nesta fase.
//!
//! **Live (F2.3)** é por FONTE (`"torrentio"`): o Node agrega o pool numa
//! consulta só e não publica quais trackers responderam. `Ok` = conjuntos
//! vazios; `Empty` = resposta válida sem item relevante (`filter_relevant_raw`)
//! ou 4xx da obra (host vivo, obra sem release); `Failed` = consulta tentada e
//! não respondida (429/5xx/rede/timeout/JSON inválido/breaker aberto).
//! `pending` nunca é inventado e `all` fica `Unknown`: o agregado `error` é do
//! ramo `/all` do Jackett, não daqui.
//!
//! **Breaker**: o caminho vivo abre/reseta o circuito.
//!
//! Fora desta fatia: composição multi-fonte, cache `raw:v1`.

use std::future::Future;
use std::pin::Pin;

use adom_core::RelevanceItem;
use adom_sources::{
    TorrentioClient, TorrentioMediaType, TorrentioOutcome, TorrentioRawItem, TorrentioSearchArgs,
};
use serde_json::{Map, Number, Value};

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::jackett_collector::process_title_precision_tail_cut;
use crate::orchestrator::jackett_live::relevant_count;
use crate::orchestrator::live_state::LiveBatchState;
use crate::raw_item::{known_size, RawItem};

/// Chave do estado vivo da fonte. O Torrentio é UMA consulta (como o Mico e o
/// Prowlarr): não há como atribuir falha/vazio a um tracker específico sem
/// inventar.
pub const TORRENTIO_LIVE_KEY: &str = "torrentio";

/// Monta o collector Torrentio. Falha de boot do cliente → `None` + log (a
/// fonte fica fora; o gateway só falha se NENHUMA fonte nativa montar).
pub fn try_torrentio_collector_from_env() -> Option<TorrentioCollector> {
    match TorrentioCollector::from_env() {
        Ok(c) => Some(c),
        Err(err) => {
            eprintln!("[search] Torrentio nativa indisponível: {err}");
            None
        }
    }
}

/// Collector que fala a API pública do Torrentio (sem rota interna de coleta).
pub struct TorrentioCollector {
    client: TorrentioClient,
}

impl TorrentioCollector {
    pub fn new(client: TorrentioClient) -> Self {
        Self { client }
    }

    pub fn from_env() -> Result<Self, String> {
        Ok(Self::new(TorrentioClient::from_env()?))
    }

    pub fn client(&self) -> &TorrentioClient {
        &self.client
    }
}

/// Estado vivo da fonte: `all` fica `Unknown` (o agregado só existe no ramo
/// `/all` do Jackett) e `pending` nunca é criado.
fn live_state(failed: bool, empty: bool) -> LiveBatchState {
    let mut state = LiveBatchState::default();
    if failed {
        state.failed.insert(TORRENTIO_LIVE_KEY.to_string());
    }
    if empty {
        state.empty.insert(TORRENTIO_LIVE_KEY.to_string());
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
/// resposta sem item relevante é `Empty` (vazio suspeito), como o `relevant: 0`
/// do Node. A régua é a MESMA do Jackett/Prowlarr (`filter_relevant_raw`).
fn live_from_items(items: &[TorrentioRawItem], job: &CollectJob) -> LiveBatchState {
    if items.is_empty() {
        return live_empty();
    }
    let entries: Vec<RelevanceItem> = items
        .iter()
        .map(|item| RelevanceItem {
            title: Some(item.title.clone()),
            title_pascal: None,
            // O pool entrega `infoHash`, não magnet/guid: a relevância decide
            // pelo título, igual ao `RawItem` do Node.
            magnet: None,
            magnet_uri: None,
            guid: None,
            // `torrentio.ts` não marca `isBr`; o build decide por `looksPtBr`.
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

impl Collector for TorrentioCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            // Fonte fora dos `providers` da request: o Node não a consultaria.
            // Nada foi prometido → live vazio (nunca falha sintética).
            if !job.wants("torrentio") {
                return Ok(batch(Vec::new(), live_ok()));
            }
            // Mesma topologia do TS: torrentio entra como tarefa global
            // (`priority=false`); scope BR e late-sweep não consultam.
            if job.late_sweep || matches!(job.scope, TaskScope::Priority) {
                return Ok(batch(Vec::new(), live_ok()));
            }
            // Obra sem IMDb/S/E válidos: o TS devolve antes do fetch.
            let Some(args) = search_args_from_job(&job) else {
                return Ok(batch(Vec::new(), live_ok()));
            };
            let outcome = self.client.search_outcome(&args).await;
            let label = outcome.label();
            match outcome {
                TorrentioOutcome::Ok(items) => {
                    let live = live_from_items(&items, &job);
                    let mapped = items.into_iter().map(raw_from_torrentio).collect();
                    Ok(batch(mapped, live))
                }
                // Configuração (kill-switch / base barrada / args incompletos):
                // a fonte nem foi consultada — o Node também não registra nada.
                TorrentioOutcome::Disabled
                | TorrentioOutcome::BlockedUrl
                | TorrentioOutcome::NoEndpoint => Ok(batch(Vec::new(), live_ok())),
                // 4xx da obra: o host está vivo (o Node não alimenta o breaker),
                // mas esta obra não tem release no pool → vazio suspeito.
                TorrentioOutcome::Http(status) if status < 500 && status != 429 => {
                    eprintln!("[search] torrentio: {label} (obra sem release no pool)");
                    Ok(batch(Vec::new(), live_empty()))
                }
                // 429/5xx, JSON inválido, rede, timeout e breaker aberto: a
                // consulta foi prometida e não foi respondida.
                failure => {
                    debug_assert!(
                        failure.is_host_failure() || failure == TorrentioOutcome::BreakerOpen
                    );
                    eprintln!("[search] torrentio: {label} (falha viva, lote vazio)");
                    Ok(batch(Vec::new(), live_failed()))
                }
            }
        })
    }
}

/// Monta os args do cliente; `None` = obra incompleta (sem rede).
fn search_args_from_job(job: &CollectJob) -> Option<TorrentioSearchArgs> {
    let media_type = TorrentioMediaType::parse(&job.kind)?;
    if job.imdb_id.is_empty() {
        return None;
    }
    let (season, episode) = match media_type {
        TorrentioMediaType::Movie => (None, None),
        TorrentioMediaType::Series => {
            let season = i32_of(job.season)?;
            let episode = i32_of(job.episode)?;
            (Some(season), Some(episode))
        }
    };
    Some(TorrentioSearchArgs {
        media_type,
        imdb_id: job.imdb_id.clone(),
        season,
        episode,
    })
}

fn i32_of(n: Option<i64>) -> Option<i32> {
    n.and_then(|v| i32::try_from(v).ok())
}

fn raw_from_torrentio(item: TorrentioRawItem) -> RawItem {
    // `tracker = item.tracker || item.Tracker || item.Indexer || item.indexer`:
    // aqui o `tracker` é o rótulo do ⚙️ (fonte indexada), vazio = sem rótulo —
    // o `display_tracker` cai no `indexer` ("torrentio"), como o Node.
    let tracker = item
        .tracker
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let sources = tracker
        .map(|t| vec![format!("tracker:{t}")])
        .unwrap_or_default();
    // `fileIdx` atravessa como campo público (o TS preserva inteiro).
    let mut extra = Map::new();
    if let Some(idx) = item.file_idx {
        extra.insert("fileIdx".into(), Value::Number(Number::from(idx)));
    }
    RawItem {
        title: Some(item.title).filter(|t| !t.is_empty()),
        info_hash: Some(item.info_hash).filter(|h| !h.is_empty()),
        // `seeders ?? 0` do TS: o pool manda 0 quando não mediu.
        seeders: Some(item.seeders),
        size_bytes: known_size(item.size),
        indexer: Some(item.indexer).filter(|s| !s.is_empty()),
        tracker: tracker.map(str::to_string),
        sources,
        // `torrentio.ts` não marca `isBr`; `looksPtBr(title)` decide no build.
        is_br: false,
        extra,
        ..RawItem::default()
    }
}

#[cfg(test)]
#[path = "torrentio_collector_support.rs"]
mod test_support;

#[cfg(test)]
#[path = "torrentio_collector_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "torrentio_collector_live_tests.rs"]
mod live_tests;

#[cfg(test)]
#[path = "torrentio_collector_breaker_tests.rs"]
mod breaker_tests;
