//! Collect opt-in via `adom_sources::BludvClient` (`SOURCES_RUST=bludv`).
//!
//! Default OFF: produção continua em [`super::NodeCollector`]
//! (`POST /internal/search/collect`). BLUDV é fonte BR (WordPress + protetor):
//! no TS entra como tarefa prioritária (`addTask(..., true)`).
//!
//! - `TaskScope::Nonpriority` → lote vazio, live sem falha (não é fonte global).
//! - `late_sweep` → lote vazio (varredura pt-BR é caminho Jackett).
//! - `Priority` / `All` → `client.search_outcome(pt_query || query)`; fail-open.
//!
//! **Identidade** é a do Node (`src/providers/bludv.ts`): o item cru tem
//! `tracker: "BLUDV"` e **não** tem `indexer`; o `_indexer` do stream nasce
//! dele (`String(item.indexer || tracker || '').trim().toLowerCase()` →
//! `"bludv"`) e o chip é `⚙️ BLUDV`. Fixar `indexer = "bludv"` movia o rótulo
//! do ⚙️ para minúsculas e a chave da sombra para outro balde. `sources` fica
//! vazio no cru (o Node publica `tracker:` a partir de `TRACKERS` no build).
//!
//! **Live (F2.5)** é por FONTE (`"bludv"`), como Prowlarr/Torrentio: o Node
//! NÃO emite `live` para o BLUDV, então a sombra compara só a identidade
//! (`compare_live:false`). `Ok` = resposta válida com item relevante; `Empty` =
//! resposta válida sem item relevante (inclusive 4xx da obra); `Failed` =
//! 429/5xx/rede/timeout. `pending` nunca é inventado e `all` fica `Unknown`.
//!
//! **`raw:v1`** só no caminho VIVO (`SOURCES_RUST=bludv`): a sombra monta o
//! cliente com `shadow` e passa `read_only`, que não lê nem grava o cache
//! bruto (o mesmo `readOnly` do `bludv.search`).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use adom_core::RelevanceItem;
use adom_sources::{BludvClient, BludvOutcome, BludvRawItem, BludvSearchOpts, RawStore};
use serde_json::{Map, Value};

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::jackett_collector::process_title_precision_tail_cut;
use crate::orchestrator::jackett_live::relevant_count;
use crate::orchestrator::live_state::LiveBatchState;
use crate::orchestrator::sources_rust::sources_rust_includes;
use crate::raw_item::{known_size, RawItem};

/// Chave do estado vivo da fonte. UMA consulta WordPress: não há como atribuir
/// falha/vazio a um card específico sem inventar.
pub const BLUDV_LIVE_KEY: &str = "bludv";

/// `SOURCES_RUST` contém o token `bludv` (CSV, case-insensitive).
pub fn sources_rust_includes_bludv() -> bool {
    sources_rust_includes("bludv")
}

/// Monta o collector só quando o env pediu BLUDV nativo. Falha de boot do
/// cliente → `None` + log (degrada para o caller usar NodeCollector).
pub fn try_bludv_collector_from_env() -> Option<BludvCollector> {
    try_bludv_collector_from_env_with_store(None)
}

/// Mesma montagem com o store do `raw:v1` injetado (gateway). `None` = sem
/// cache bruto; o caminho vivo continua fail-open.
pub fn try_bludv_collector_from_env_with_store(
    raw_store: Option<Arc<dyn RawStore>>,
) -> Option<BludvCollector> {
    if !sources_rust_includes_bludv() {
        return None;
    }
    match BludvCollector::from_env() {
        Ok(collector) => Some(match raw_store {
            Some(store) => collector.with_raw_store(store),
            None => collector,
        }),
        Err(err) => {
            eprintln!("[search] SOURCES_RUST=bludv mas BludvClient falhou: {err}");
            None
        }
    }
}

/// Collector que raspa o WordPress BLUDV (sem POST `/internal/search/collect`).
pub struct BludvCollector {
    client: BludvClient,
    /// Sombra read-only: sem `raw:v1` (leitura ou escrita).
    shadow: bool,
}

impl BludvCollector {
    pub fn new(client: BludvClient) -> Self {
        Self {
            client,
            shadow: false,
        }
    }

    pub fn from_env() -> Result<Self, String> {
        Ok(Self::new(BludvClient::from_env()?))
    }

    /// Store do `raw:v1` compartilhado com o Node (caminho vivo).
    pub fn with_raw_store(mut self, store: Arc<dyn RawStore>) -> Self {
        self.client = self.client.clone().with_raw_store(store);
        self
    }

    /// Modo sombra: `readOnly` do Node (sem cache bruto, sem status).
    pub fn with_shadow(mut self, shadow: bool) -> Self {
        self.shadow = shadow;
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
fn live_from_items(items: &[BludvRawItem], job: &CollectJob) -> LiveBatchState {
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

fn batch(items: Vec<RawItem>, live: LiveBatchState) -> CollectBatch {
    CollectBatch {
        items,
        partial: false,
        live: Some(live),
    }
}

impl Collector for BludvCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            // Fonte BR independente do PROVIDER (só o kill-switch do cliente);
            // o `wants` existe para espelhar a régua do Node por fonte.
            if !job.wants("bludv") {
                return Ok(batch(Vec::new(), live_ok()));
            }
            // Topologia TS: bludv é tarefa BR (`priority=true`); globais e
            // late-sweep não consultam.
            if job.late_sweep || matches!(job.scope, TaskScope::Nonpriority) {
                return Ok(batch(Vec::new(), live_ok()));
            }
            let query = br_query(&job);
            if query.is_empty() {
                return Ok(batch(Vec::new(), live_ok()));
            }
            let opts = BludvSearchOpts {
                // `dubbedOnly` chega pelo `RequestSelection` (o default do
                // operador já foi aplicado ao `options` da request).
                dubbed_only: job.dubbed_only,
                read_only: self.shadow,
            };
            let outcome = self.client.search_outcome(query, &opts).await;
            let label = outcome.label();
            match outcome {
                BludvOutcome::Ok(items) => {
                    let live = live_from_items(&items, &job);
                    let mapped = items.into_iter().map(raw_from_bludv).collect();
                    Ok(batch(mapped, live))
                }
                // Configuração (kill-switch / base barrada / consulta vazia):
                // a fonte nem foi consultada — o Node também não registra nada.
                BludvOutcome::Disabled | BludvOutcome::BlockedUrl => {
                    Ok(batch(Vec::new(), live_ok()))
                }
                // 4xx da obra/site: o host está vivo; sem release para esta
                // obra → vazio suspeito (nunca falha sintética).
                BludvOutcome::Http(status) if status < 500 && status != 429 => {
                    eprintln!("[search] bludv: {label} (obra sem release no site)");
                    Ok(batch(Vec::new(), live_empty()))
                }
                // 429/5xx, rede, timeout e redirect inválido: a consulta foi
                // prometida e não foi respondida.
                failure => {
                    debug_assert!(failure.is_host_failure());
                    eprintln!("[search] bludv: {label} (falha viva, lote vazio)");
                    Ok(batch(Vec::new(), live_failed()))
                }
            }
        })
    }
}

/// Sites BR indexam por título pt-BR (`ptQuery || query` no TS).
fn br_query(job: &CollectJob) -> &str {
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
    use crate::orchestrator::sources_rust::sources_rust_csv_includes;
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
    fn token_bludv_no_csv() {
        assert!(sources_rust_csv_includes("bludv", "bludv"));
        assert!(sources_rust_csv_includes("jackett,bludv", "bludv"));
        assert!(!sources_rust_csv_includes("jackett", "bludv"));
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
