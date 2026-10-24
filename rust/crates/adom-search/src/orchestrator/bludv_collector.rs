//! Collect nativo via `adom_sources::BludvClient`.
//!
//! Monta sempre que o cliente sobe; falha de boot → log e a fonte fica fora.
//! BLUDV é fonte BR (WordPress + protetor): no TS entra como tarefa prioritária
//! (`addTask(..., true)`).
//!
//! - `TaskScope::Nonpriority` → lote vazio, live sem falha (não é fonte global).
//! - `late_sweep` → lote vazio (varredura pt-BR é caminho Jackett).
//! - `Priority` / `All` → `client.search_outcome(pt_query || query)`; fail-open.
//!
//! **Identidade** é a do Node (`src/providers/bludv.ts`): o item cru tem
//! `tracker: "BLUDV"` e **não** tem `indexer`; o `_indexer` do stream nasce
//! dele (`String(item.indexer || tracker || '').trim().toLowerCase()` →
//! `"bludv"`) e o chip é `⚙️ BLUDV`. Fixar `indexer = "bludv"` movia o rótulo
//! do ⚙️ para minúsculas e a chave do cache para outro balde. `sources` fica
//! vazio no cru (o Node publica `tracker:` a partir de `TRACKERS` no build).
//!
//! **Live (F2.5)** é por FONTE (`"bludv"`), como Prowlarr/Torrentio: `Ok` =
//! resposta válida com item relevante; `Empty` = resposta válida sem item
//! relevante (inclusive 4xx da obra); `Failed` = 429/5xx/rede/timeout.
//! `pending` nunca é inventado e `all` fica `Unknown`.
//!
//! **`raw:v1`** no caminho vivo: lê e grava o cache bruto normalmente.

use std::sync::Arc;

use adom_core::RelevanceItem;
use adom_sources::{BludvClient, BludvRawItem, RawStore};
use serde_json::{Map, Value};

#[cfg(test)]
use crate::internal_types::TaskScope;
use crate::orchestrator::collect::CollectJob;
#[cfg(test)]
use crate::orchestrator::collect::{CollectBatch, Collector};
use crate::orchestrator::jackett_collector::process_title_precision_tail_cut;
use crate::orchestrator::jackett_live::relevant_count;
use crate::orchestrator::live_state::LiveBatchState;
use crate::raw_item::{known_size, RawItem};

/// Chave do estado vivo da fonte. UMA consulta WordPress: não há como atribuir
/// falha/vazio a um card específico sem inventar.
pub const BLUDV_LIVE_KEY: &str = "bludv";

/// Monta o collector BLUDV. Falha de boot do cliente → `None` + log (a fonte
/// fica fora; o gateway só falha se NENHUMA fonte nativa montar).
pub fn try_bludv_collector_from_env() -> Option<BludvCollector> {
    try_bludv_collector_from_env_with_store(None)
}

/// Mesma montagem com o store do `raw:v1` injetado (gateway). `None` = sem
/// cache bruto; o caminho vivo continua fail-open.
pub fn try_bludv_collector_from_env_with_store(
    raw_store: Option<Arc<dyn RawStore>>,
) -> Option<BludvCollector> {
    match BludvCollector::from_env() {
        Ok(collector) => Some(match raw_store {
            Some(store) => collector.with_raw_store(store),
            None => collector,
        }),
        Err(err) => {
            eprintln!("[search] BLUDV nativa indisponível: {err}");
            None
        }
    }
}

/// Collector que raspa o WordPress BLUDV (sem rota interna de coleta).
pub struct BludvCollector {
    client: BludvClient,
}

impl BludvCollector {
    pub fn new(client: BludvClient) -> Self {
        Self { client }
    }

    pub fn from_env() -> Result<Self, String> {
        Ok(Self::new(BludvClient::from_env()?))
    }

    /// Store do `raw:v1` compartilhado com o Node (caminho vivo).
    pub fn with_raw_store(mut self, store: Arc<dyn RawStore>) -> Self {
        self.client = self.client.clone().with_raw_store(store);
        self
    }

    pub fn client(&self) -> &BludvClient {
        &self.client
    }
}

/// Estado vivo da fonte: `all` fica `Unknown` e `pending` nunca é criado.
fn live_state(failed: bool, empty: bool) -> LiveBatchState {
    let mut state = LiveBatchState::default();
    if failed {
        state.failed.insert(BLUDV_LIVE_KEY.to_string());
    }
    if empty {
        state.empty.insert(BLUDV_LIVE_KEY.to_string());
    }
    state
}

pub(crate) fn live_ok() -> LiveBatchState {
    live_state(false, false)
}

pub(crate) fn live_empty() -> LiveBatchState {
    live_state(false, true)
}

pub(crate) fn live_failed() -> LiveBatchState {
    live_state(true, false)
}

/// Resposta válida é `Ok` quando ALGUM item passa na relevância da obra;
/// sem item relevante é `Empty` (vazio suspeito), como o `relevant: 0` do TS.
/// A régua é a mesma do Jackett/Prowlarr (`filter_relevant_raw`).
pub(super) fn live_from_items(items: &[BludvRawItem], job: &CollectJob) -> LiveBatchState {
    if items.is_empty() {
        return live_empty();
    }
    let entries: Vec<RelevanceItem> = items
        .iter()
        .map(|item| RelevanceItem {
            title: Some(item.title.clone()),
            title_pascal: None,
            magnet: Some(item.magnet.clone()),
            magnet_uri: None,
            guid: None,
            // O provider marca `isBr: true`; o filtro de título lê igual.
            is_br: true,
        })
        .collect();
    let relevant = relevant_count(&entries, job, process_title_precision_tail_cut());
    if relevant == 0 {
        live_empty()
    } else {
        live_ok()
    }
}

/// Sites BR indexam por título pt-BR (`ptQuery || query` no TS).
pub(super) fn br_query(job: &CollectJob) -> &str {
    job.pt_query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(job.query.trim())
}

pub(crate) fn raw_from_bludv(item: BludvRawItem) -> RawItem {
    let magnet = item.magnet.trim();
    let mut extra = Map::new();
    if !item.audio.is_empty() {
        extra.insert("audio".into(), Value::String(item.audio.clone()));
    }
    RawItem {
        title: Some(item.title).filter(|t| !t.is_empty()),
        magnet: Some(magnet.to_string()).filter(|m| !m.is_empty()),
        // O Node NÃO publica `infoHash` no item cru do BLUDV: o build extrai do
        // magnet. Manter `None` evita escrever um campo que a fonte não deu.
        info_hash: None,
        seeders: Some(item.seeders),
        // Mesma régua do `knownSize` do `toStremioStream` (1 KB sentinela).
        size_bytes: known_size(item.size),
        // `_indexer = item.indexer || tracker` → "bludv" (o rótulo é o tracker).
        indexer: None,
        tracker: Some("BLUDV".into()),
        // O cru do Node não tem `sources`; o build monta os `tracker:` fixos.
        sources: Vec::new(),
        is_br: true,
        extra,
        ..RawItem::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::collect::CollectJob;
    use adom_sources::BludvConfig;
    use serde_json::json;

    fn base_job() -> CollectJob {
        CollectJob {
            encoded: "e30".into(),
            scope: TaskScope::All,
            kind: "movie".into(),
            imdb_id: "tt0133093".into(),
            season: None,
            episode: None,
            year: Some(json!(1999)),
            names: vec!["The Matrix".into()],
            query: "The Matrix 1999".into(),
            pt_query: Some("Matrix 1999".into()),
            sweep_query: Some("Matrix".into()),
            original_query: None,
            multi_work_query: None,
            priority: true,
            deadline_at: 1_700_000_000_000,
            late_sweep: false,
            providers: Vec::new(),
            jackett_indexers: Vec::new(),
            dubbed_only: false,
            mico_default: false,
        }
    }

    #[test]
    fn br_query_prefere_pt() {
        assert_eq!(br_query(&base_job()), "Matrix 1999");
        let en = CollectJob {
            pt_query: None,
            ..base_job()
        };
        assert_eq!(br_query(&en), "The Matrix 1999");
        let empty_pt = CollectJob {
            pt_query: Some("  ".into()),
            ..base_job()
        };
        assert_eq!(br_query(&empty_pt), "The Matrix 1999");
    }

    /// Identidade do Node: tracker "BLUDV", SEM indexer, sem sources; o
    /// `_indexer` do build nasce do tracker (coberto no list_builder).
    #[test]
    fn mapa_marca_tracker_br_e_hash() {
        let hash = "abcd0123456789abcdef0123456789abcdef0123";
        let raw = raw_from_bludv(BludvRawItem {
            title: "Matrix 1999 [1080p WEB-DL DUBLADO]".into(),
            magnet: format!("magnet:?xt=urn:btih:{hash}&dn=x"),
            seeders: 1.0,
            size: Some(1_000.0),
            tracker: "BLUDV".into(),
            audio: "dublado".into(),
            is_br: true,
        });
        assert_eq!(raw.tracker.as_deref(), Some("BLUDV"));
        assert_eq!(raw.indexer, None, "Node não publica indexer no cru");
        assert!(raw.sources.is_empty(), "Node não publica sources no cru");
        assert!(raw.is_br);
        assert_eq!(raw.hash(), hash, "hash vem do magnet, como no Node");
        assert_eq!(raw.extra.get("audio"), Some(&json!("dublado")));
        assert_eq!(raw.seeders, Some(1.0));
    }

    #[test]
    fn tamanho_sentinela_1kb_vira_desconhecido() {
        let raw = raw_from_bludv(BludvRawItem {
            title: "X".into(),
            magnet: "magnet:?xt=urn:btih:abcd0123456789abcdef0123456789abcdef0123".into(),
            seeders: 1.0,
            size: Some(1024.0),
            tracker: "BLUDV".into(),
            audio: "dublado".into(),
            is_br: true,
        });
        assert_eq!(raw.size_bytes, None);
    }

    #[test]
    fn live_de_item_relevante_e_ok() {
        let item = BludvRawItem {
            title: "The Matrix 1999 [1080p WEB-DL DUBLADO]".into(),
            magnet: "magnet:?xt=urn:btih:abcd0123456789abcdef0123456789abcdef0123".into(),
            seeders: 1.0,
            size: None,
            tracker: "BLUDV".into(),
            audio: "dublado".into(),
            is_br: true,
        };
        let live = live_from_items(std::slice::from_ref(&item), &base_job());
        assert!(live.failed.is_empty());
        assert!(live.empty.is_empty());
        assert_eq!(
            live.all,
            crate::orchestrator::live_state::LiveAllState::Unknown
        );
        assert!(live.pending.is_empty(), "pending nunca é inventado");

        // Obra diferente: resposta válida sem item relevante = Empty.
        let other = CollectJob {
            names: vec!["Outra Obra".into()],
            query: "Outra Obra 2024".into(),
            pt_query: None,
            year: Some(json!(2024)),
            ..base_job()
        };
        let live = live_from_items(&[item], &other);
        assert!(live.empty.contains(BLUDV_LIVE_KEY));
        assert!(live.failed.is_empty());
    }

    #[test]
    fn live_vazio_e_falha_tem_all_unknown_e_sem_pending() {
        for state in [live_ok(), live_empty(), live_failed()] {
            assert_eq!(
                state.all,
                crate::orchestrator::live_state::LiveAllState::Unknown
            );
            assert!(state.pending.is_empty());
        }
        assert!(live_empty().empty.contains(BLUDV_LIVE_KEY));
        assert!(live_failed().failed.contains(BLUDV_LIVE_KEY));
    }

    #[tokio::test]
    async fn nonpriority_e_late_sweep_nao_consultam() {
        // fail-open sem rede se o early-return falhar
        let cfg = BludvConfig {
            enabled: false,
            ..Default::default()
        };
        let client = BludvClient::new(cfg).expect("client");
        let collector = BludvCollector::new(client);

        let nonpriority = CollectJob {
            scope: TaskScope::Nonpriority,
            priority: false,
            ..base_job()
        };
        let batch = collector.collect(nonpriority).await.expect("ok");
        assert!(batch.items.is_empty());
        assert!(batch
            .live
            .as_ref()
            .is_some_and(|live| live.failed.is_empty()));

        let late = CollectJob {
            late_sweep: true,
            ..base_job()
        };
        let batch = collector.collect(late).await.expect("ok");
        assert!(batch.items.is_empty());
    }

    #[tokio::test]
    async fn priority_com_disabled_fail_open_vazio() {
        let cfg = BludvConfig {
            enabled: false,
            ..Default::default()
        };
        let client = BludvClient::new(cfg).expect("client");
        let collector = BludvCollector::new(client);
        let priority = CollectJob {
            scope: TaskScope::Priority,
            priority: true,
            ..base_job()
        };
        let batch = collector.collect(priority).await.expect("ok");
        assert!(batch.items.is_empty());
        assert!(!batch.partial);
        assert!(batch
            .live
            .as_ref()
            .is_some_and(|live| live.failed.is_empty()));
    }
}

#[cfg(test)]
#[path = "bludv_collector_live_tests.rs"]
mod live_tests;
