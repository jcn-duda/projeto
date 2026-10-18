//! Collect opt-in via `adom_sources::TorrentioClient` (`SOURCES_RUST=torrentio`).
//!
//! Default OFF: produção continua em [`super::NodeCollector`]
//! (`POST /internal/search/collect`). Espelha o padrão do
//! [`super::ProwlarrCollector`]: pool global por IMDb, sem plano Torznab/BR.
//!
//! - `TaskScope::Priority` → lote vazio (não é fonte BR).
//! - `late_sweep` → lote vazio (varredura pt-BR é caminho Jackett).
//! - `All` / `Nonpriority` → `client.search` por IMDb (+ S/E em série); fail-open.
//! - `fileIdx` preservado em `RawItem.extra` (cliente já trunca; não consumido
//!   no play/HMAC nesta fase).
//!
//! Fora desta fatia: BLUDV/Mico, composição com Jackett/Prowlarr, cache `raw:v1`.

use std::future::Future;
use std::pin::Pin;

use adom_sources::{
    TorrentioClient, TorrentioMediaType, TorrentioRawItem, TorrentioSearchArgs,
};
use serde_json::{Map, Number, Value};

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::sources_rust::sources_rust_includes;
use crate::raw_item::RawItem;

/// `SOURCES_RUST` contém o token `torrentio` (CSV, case-insensitive).
pub fn sources_rust_includes_torrentio() -> bool {
    sources_rust_includes("torrentio")
}

/// Monta o collector só quando o env pediu Torrentio nativo. Falha de boot do
/// cliente → `None` + log (degrada para o caller usar NodeCollector).
pub fn try_torrentio_collector_from_env() -> Option<TorrentioCollector> {
    if !sources_rust_includes_torrentio() {
        return None;
    }
    match TorrentioCollector::from_env() {
        Ok(c) => Some(c),
        Err(err) => {
            eprintln!("[search] SOURCES_RUST=torrentio mas TorrentioClient falhou: {err}");
            None
        }
    }
}

/// Collector que fala a API pública do Torrentio (sem POST `/internal/search/collect`).
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

impl Collector for TorrentioCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            // Mesma topologia do TS: torrentio entra como tarefa global
            // (`priority=false`); scope BR e late-sweep não consultam.
            if job.late_sweep || matches!(job.scope, TaskScope::Priority) {
                return Ok(CollectBatch::default());
            }
            let Some(args) = search_args_from_job(&job) else {
                return Ok(CollectBatch::default());
            };
            let items = self
                .client
                .search(&args)
                .await
                .into_iter()
                .map(raw_from_torrentio)
                .collect();
            Ok(CollectBatch {
                items,
                partial: false,
            })
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
    let tracker = item
        .tracker
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let sources = tracker
        .map(|t| vec![format!("tracker:{t}")])
        .unwrap_or_default();
    let mut extra = Map::new();
    if let Some(idx) = item.file_idx {
        extra.insert("fileIdx".into(), Value::Number(Number::from(idx)));
    }
    RawItem {
        title: Some(item.title).filter(|t| !t.is_empty()),
        info_hash: Some(item.info_hash).filter(|h| !h.is_empty()),
        seeders: Some(item.seeders),
        size_bytes: item.size,
        indexer: Some(item.indexer).filter(|s| !s.is_empty()),
        sources,
        is_br: false,
        extra,
        ..RawItem::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::collect::CollectJob;
    use crate::orchestrator::sources_rust::sources_rust_csv_includes;
    use adom_sources::TorrentioConfig;
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
    fn token_torrentio_no_csv() {
        assert!(sources_rust_csv_includes("torrentio", "torrentio"));
        assert!(sources_rust_csv_includes("jackett,torrentio", "torrentio"));
        assert!(!sources_rust_csv_includes("jackett", "torrentio"));
    }

    #[test]
    fn mapa_preserva_file_idx_indexer_e_sources() {
        let raw = raw_from_torrentio(TorrentioRawItem {
            title: "The Matrix 1999".into(),
            info_hash: "abcd0123456789abcdef0123456789abcdef01".into(),
            seeders: 10.0,
            size: Some(1_000.0),
            tracker: Some("ThePirateBay".into()),
            indexer: "torrentio".into(),
            file_idx: Some(2),
        });
        assert_eq!(raw.indexer.as_deref(), Some("torrentio"));
        assert_eq!(raw.sources, vec!["tracker:ThePirateBay".to_string()]);
        assert!(!raw.is_br);
        assert_eq!(raw.extra.get("fileIdx"), Some(&json!(2)));
        assert_eq!(
            raw.info_hash.as_deref(),
            Some("abcd0123456789abcdef0123456789abcdef01")
        );
    }

    #[test]
    fn serie_sem_se_nao_monta_args() {
        let job = CollectJob {
            kind: "series".into(),
            season: None,
            episode: Some(1),
            ..base_job()
        };
        assert!(search_args_from_job(&job).is_none());
    }

    #[test]
    fn filme_monta_args_por_imdb() {
        let args = search_args_from_job(&base_job()).expect("args");
        assert_eq!(args.media_type, TorrentioMediaType::Movie);
        assert_eq!(args.imdb_id, "tt0133093");
        assert_eq!(args.season, None);
        assert_eq!(args.episode, None);
    }

    #[tokio::test]
    async fn priority_e_late_sweep_nao_consultam() {
        let mut cfg = TorrentioConfig::default();
        cfg.enabled = false; // fail-open sem rede se o early-return falhar
        let client = TorrentioClient::new(cfg).expect("client");
        let collector = TorrentioCollector::new(client);

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
    async fn disabled_fail_open_vazio() {
        let mut cfg = TorrentioConfig::default();
        cfg.enabled = false;
        let client = TorrentioClient::new(cfg).expect("client");
        let collector = TorrentioCollector::new(client);
        let batch = collector.collect(base_job()).await.expect("ok");
        assert!(batch.items.is_empty());
        assert!(!batch.partial);
    }
}
