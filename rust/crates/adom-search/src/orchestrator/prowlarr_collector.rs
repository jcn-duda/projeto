//! Collect opt-in via `adom_sources::ProwlarrClient` (`SOURCES_RUST=prowlarr`).
//!
//! Default OFF: produção continua em [`super::NodeCollector`]
//! (`POST /internal/search/collect`). Espelha o padrão do
//! [`super::JackettCollector`], sem plano Torznab/BR/breaker — o Prowlarr do
//! TS (`prowlarr.search(query)`) é uma única consulta global.
//!
//! - `TaskScope::Priority` → lote vazio (não é fonte BR).
//! - `late_sweep` → lote vazio (varredura pt-BR é caminho Jackett; sem
//!   `ignore_breaker` aqui).
//! - `All` / `Nonpriority` → `client.search(job.query)`; fail-open.
//!
//! Fora desta fatia: composição multi-fonte, cache `raw:v1`.

use std::future::Future;
use std::pin::Pin;

use adom_sources::{ProwlarrClient, ProwlarrRawItem};

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::sources_rust::sources_rust_includes;
use crate::raw_item::RawItem;

/// `SOURCES_RUST` contém o token `prowlarr` (CSV, case-insensitive).
pub fn sources_rust_includes_prowlarr() -> bool {
    sources_rust_includes("prowlarr")
}

/// Monta o collector só quando o env pediu Prowlarr nativo. Falha de boot do
/// cliente → `None` + log (degrada para o caller usar NodeCollector).
pub fn try_prowlarr_collector_from_env() -> Option<ProwlarrCollector> {
    if !sources_rust_includes_prowlarr() {
        return None;
    }
    match ProwlarrCollector::from_env() {
        Ok(c) => Some(c),
        Err(err) => {
            eprintln!("[search] SOURCES_RUST=prowlarr mas ProwlarrClient falhou: {err}");
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

impl Collector for ProwlarrCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            // Mesma topologia do TS: prowlarr entra como tarefa global
            // (`priority=false`); scope BR e late-sweep não consultam.
            if job.late_sweep || matches!(job.scope, TaskScope::Priority) {
                return Ok(CollectBatch::default());
            }
            if job.query.is_empty() {
                return Ok(CollectBatch::default());
            }
            let items = self
                .client
                .search(&job.query)
                .await
                .into_iter()
                .map(raw_from_prowlarr)
                .collect();
            Ok(CollectBatch {
                items,
                partial: false,
            })
        })
    }
}

fn raw_from_prowlarr(item: ProwlarrRawItem) -> RawItem {
    let tracker = item
        .tracker
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let sources = tracker
        .map(|t| vec![format!("tracker:{t}")])
        .unwrap_or_default();
    // Provider fixo no `indexer` (como o nome exportado do TS); o tracker do
    // Prowlarr vai em `sources` — paridade com o mapa que só preenche tracker.
    RawItem {
        title: Some(item.title).filter(|t| !t.is_empty()),
        magnet: item.magnet,
        info_hash: item.info_hash,
        seeders: item.seeders,
        size_bytes: item.size,
        indexer: Some("prowlarr".into()),
        sources,
        is_br: false,
        ..RawItem::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::collect::CollectJob;
    use crate::orchestrator::sources_rust::sources_rust_csv_includes;
    use adom_sources::ProwlarrConfig;
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
            priority: false,
            deadline_at: 1_700_000_000_000,
            late_sweep: false,
        }
    }

    #[test]
    fn token_prowlarr_no_csv() {
        assert!(sources_rust_csv_includes("prowlarr", "prowlarr"));
        assert!(sources_rust_csv_includes("jackett,prowlarr", "prowlarr"));
        assert!(!sources_rust_csv_includes("jackett", "prowlarr"));
    }

    #[test]
    fn mapa_preenche_indexer_e_sources() {
        let raw = raw_from_prowlarr(ProwlarrRawItem {
            title: "The Matrix 1999".into(),
            magnet: Some("magnet:?xt=urn:btih:abcd".into()),
            info_hash: Some("abcd".into()),
            seeders: Some(10.0),
            size: Some(1_000.0),
            tracker: Some("Nyaa".into()),
        });
        assert_eq!(raw.indexer.as_deref(), Some("prowlarr"));
        assert_eq!(raw.sources, vec!["tracker:Nyaa".to_string()]);
        assert!(!raw.is_br);
        assert_eq!(raw.title.as_deref(), Some("The Matrix 1999"));
    }

    #[tokio::test]
    async fn priority_e_late_sweep_nao_consultam() {
        // Sem chave → search devolveria []; o early-return evita até o warn.
        let client = ProwlarrClient::new(ProwlarrConfig::default()).expect("client");
        let collector = ProwlarrCollector::new(client);

        let priority = CollectJob {
            scope: TaskScope::Priority,
            priority: true,
            ..base_job()
        };
        let batch = collector.collect(priority).await.expect("ok");
        assert!(batch.items.is_empty());

        let late = CollectJob {
            late_sweep: true,
            ..base_job()
        };
        let batch = collector.collect(late).await.expect("ok");
        assert!(batch.items.is_empty());
    }

    #[tokio::test]
    async fn all_sem_chave_fail_open_vazio() {
        let client = ProwlarrClient::new(ProwlarrConfig::default()).expect("client");
        let collector = ProwlarrCollector::new(client);
        let batch = collector.collect(base_job()).await.expect("ok");
        assert!(batch.items.is_empty());
        assert!(!batch.partial);
    }
}
