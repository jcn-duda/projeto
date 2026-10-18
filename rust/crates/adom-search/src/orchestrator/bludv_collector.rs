//! Collect opt-in via `adom_sources::BludvClient` (`SOURCES_RUST=bludv`).
//!
//! Default OFF: produção continua em [`super::NodeCollector`]
//! (`POST /internal/search/collect`). BLUDV é fonte BR (WordPress + protetor):
//! no TS entra como tarefa prioritária (`addTask(..., true)`).
//!
//! - `TaskScope::Nonpriority` → lote vazio (não é fonte global).
//! - `late_sweep` → lote vazio (varredura pt-BR é caminho Jackett).
//! - `Priority` / `All` → `client.search(pt_query || query)`; fail-open.
//! - Gate de anúncio já pulado no cliente (orçamento 0 ms no caminho de busca).
//!
//! Fora desta fatia: composição com Jackett/Mico, `dubbedOnly` do usuário no
//! scrape, cache `raw:v1`.

use std::future::Future;
use std::pin::Pin;

use adom_core::extract_info_hash;
use adom_sources::{BludvClient, BludvRawItem, BludvSearchOpts};
use serde_json::{Map, Value};

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::sources_rust::sources_rust_includes;
use crate::raw_item::RawItem;

/// `SOURCES_RUST` contém o token `bludv` (CSV, case-insensitive).
pub fn sources_rust_includes_bludv() -> bool {
    sources_rust_includes("bludv")
}

/// Monta o collector só quando o env pediu BLUDV nativo. Falha de boot do
/// cliente → `None` + log (degrada para o caller usar NodeCollector).
pub fn try_bludv_collector_from_env() -> Option<BludvCollector> {
    if !sources_rust_includes_bludv() {
        return None;
    }
    match BludvCollector::from_env() {
        Ok(c) => Some(c),
        Err(err) => {
            eprintln!("[search] SOURCES_RUST=bludv mas BludvClient falhou: {err}");
            None
        }
    }
}

/// Collector que raspa o WordPress BLUDV (sem POST `/internal/search/collect`).
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

    pub fn client(&self) -> &BludvClient {
        &self.client
    }
}

impl Collector for BludvCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            // Topologia TS: bludv é tarefa BR (`priority=true`); globais e
            // late-sweep não consultam.
            if job.late_sweep || matches!(job.scope, TaskScope::Nonpriority) {
                return Ok(CollectBatch::default());
            }
            let query = br_query(&job);
            if query.is_empty() {
                return Ok(CollectBatch::default());
            }
            // `dubbedOnly` do usuário ainda não viaja no CollectJob nesta fatia.
            let opts = BludvSearchOpts::default();
            let items = self
                .client
                .search(query, &opts)
                .await
                .into_iter()
                .map(raw_from_bludv)
                .collect();
            Ok(CollectBatch {
                items,
                partial: false,
            })
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

fn raw_from_bludv(item: BludvRawItem) -> RawItem {
    let magnet = item.magnet.trim();
    let info_hash = extract_info_hash(magnet);
    let mut extra = Map::new();
    if !item.audio.is_empty() {
        extra.insert("audio".into(), Value::String(item.audio.clone()));
    }
    RawItem {
        title: Some(item.title).filter(|t| !t.is_empty()),
        magnet: Some(magnet.to_string()).filter(|m| !m.is_empty()),
        info_hash,
        seeders: Some(item.seeders),
        size_bytes: item.size,
        // Rótulo do provider standalone (não o cardigann `bludv-cardigann`).
        indexer: Some("bludv".into()),
        sources: vec!["tracker:BLUDV".into()],
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

    #[test]
    fn mapa_marca_br_tracker_e_hash() {
        // 40 hex — `extract_info_hash` rejeita comprimento ≠ 40.
        let hash = "abcd0123456789abcdef0123456789abcdef0123";
        let raw = raw_from_bludv(BludvRawItem {
            title: "Matrix 1999 Dublado".into(),
            magnet: format!("magnet:?xt=urn:btih:{hash}&dn=x"),
            seeders: 1.0,
            size: Some(1_000.0),
            tracker: "BLUDV".into(),
            audio: "dublado".into(),
            is_br: true,
        });
        assert_eq!(raw.indexer.as_deref(), Some("bludv"));
        assert_eq!(raw.sources, vec!["tracker:BLUDV".to_string()]);
        assert!(raw.is_br);
        assert_eq!(raw.info_hash.as_deref(), Some(hash));
        assert_eq!(raw.extra.get("audio"), Some(&json!("dublado")));
        assert_eq!(raw.seeders, Some(1.0));
    }

    #[tokio::test]
    async fn nonpriority_e_late_sweep_nao_consultam() {
        let mut cfg = BludvConfig::default();
        cfg.enabled = false; // fail-open sem rede se o early-return falhar
        let client = BludvClient::new(cfg).expect("client");
        let collector = BludvCollector::new(client);

        let nonpriority = CollectJob {
            scope: TaskScope::Nonpriority,
            priority: false,
            ..base_job()
        };
        let batch = collector.collect(nonpriority).await.expect("ok");
        assert!(batch.items.is_empty());

        let late = CollectJob {
            late_sweep: true,
            ..base_job()
        };
        let batch = collector.collect(late).await.expect("ok");
        assert!(batch.items.is_empty());
    }

    #[tokio::test]
    async fn priority_com_disabled_fail_open_vazio() {
        let mut cfg = BludvConfig::default();
        cfg.enabled = false;
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
    }
}
