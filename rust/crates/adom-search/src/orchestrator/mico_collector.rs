//! Collect opt-in via `adom_sources::MicoClient` (`SOURCES_RUST=mico`).
//!
//! Default OFF: produção continua em [`super::NodeCollector`]
//! (`POST /internal/search/collect`). Mico é card virtual BR (consulta por
//! IMDb): no TS entra como tarefa prioritária junto do BLUDV.
//!
//! - `TaskScope::Nonpriority` → lote vazio (não é fonte global).
//! - `late_sweep` → lote vazio (varredura pt-BR é caminho Jackett).
//! - `Priority` / `All` → `client.search` por IMDb (+ S/E em série); fail-open.
//!
//! Fora desta fatia: composição com Jackett/BLUDV, cache `raw:v1`, captura
//! do magnet-bank.

use std::future::Future;
use std::pin::Pin;

use adom_sources::{MicoClient, MicoMediaType, MicoRawItem, MicoSearchArgs};
use serde_json::Value;

use crate::internal_types::TaskScope;
use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector};
use crate::orchestrator::sources_rust::sources_rust_includes;
use crate::raw_item::RawItem;

/// `SOURCES_RUST` contém o token `mico` (CSV, case-insensitive).
pub fn sources_rust_includes_mico() -> bool {
    sources_rust_includes("mico")
}

/// Monta o collector só quando o env pediu Mico nativo. Falha de boot do
/// cliente → `None` + log (degrada para o caller usar NodeCollector).
pub fn try_mico_collector_from_env() -> Option<MicoCollector> {
    if !sources_rust_includes_mico() {
        return None;
    }
    match MicoCollector::from_env() {
        Ok(c) => Some(c),
        Err(err) => {
            eprintln!("[search] SOURCES_RUST=mico mas MicoClient falhou: {err}");
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
                return Ok(CollectBatch {
                    items: Vec::new(),
                    partial: false,
                    live: Some(crate::orchestrator::live_state::LiveBatchState::default()),
                });
            }
            // Topologia TS: mico é tarefa BR (`priority=true`); globais e
            // late-sweep não consultam.
            if job.late_sweep || matches!(job.scope, TaskScope::Nonpriority) {
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
                .map(raw_from_mico)
                .collect();
            Ok(CollectBatch {
                items,
                partial: false,
                // Coletor nativo: sem o contrato vivo por indexer do Node.
                live: None,
            })
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

fn raw_from_mico(item: MicoRawItem) -> RawItem {
    let magnet = item.magnet.trim();
    RawItem {
        title: Some(item.title).filter(|t| !t.is_empty()),
        magnet: Some(magnet.to_string()).filter(|m| !m.is_empty()),
        info_hash: Some(item.info_hash).filter(|h| !h.is_empty()),
        seeders: Some(item.seeders),
        size_bytes: item.size,
        indexer: Some(item.indexer).filter(|s| !s.is_empty()),
        sources: Vec::new(),
        is_br: item.is_br,
        ..RawItem::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::collect::CollectJob;
    use crate::orchestrator::sources_rust::sources_rust_csv_includes;
    use adom_sources::MicoConfig;
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
    fn token_mico_no_csv() {
        assert!(sources_rust_csv_includes("mico", "mico"));
        assert!(sources_rust_csv_includes("jackett,mico", "mico"));
        assert!(!sources_rust_csv_includes("jackett", "mico"));
    }

    #[test]
    fn mapa_preserva_hash_indexer_e_br() {
        let raw = raw_from_mico(MicoRawItem {
            title: "Matrix 1999".into(),
            info_hash: "abcd0123456789abcdef0123456789abcdef01".into(),
            magnet: "magnet:?xt=urn:btih:abcd0123456789abcdef0123456789abcdef01".into(),
            seeders: 1.0,
            size: Some(1_000.0),
            indexer: "mico".into(),
            is_br: true,
        });
        assert_eq!(raw.indexer.as_deref(), Some("mico"));
        assert!(raw.is_br);
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
        assert_eq!(args.media_type, MicoMediaType::Movie);
        assert_eq!(args.imdb_id, "tt0133093");
        assert_eq!(args.season, None);
        assert_eq!(args.episode, None);
        assert_eq!(args.year, Some(1999));
    }

    #[test]
    fn year_aceita_string_suja() {
        let job = CollectJob {
            year: Some(json!("1999–")),
            ..base_job()
        };
        let args = search_args_from_job(&job).expect("args");
        assert_eq!(args.year, Some(1999));
    }

    #[tokio::test]
    async fn nonpriority_e_late_sweep_nao_consultam() {
        let cfg = MicoConfig {
            enabled: false,
            ..Default::default()
        };
        let client = MicoClient::new(cfg).expect("client");
        let collector = MicoCollector::new(client);

        let nonpriority = CollectJob {
            scope: TaskScope::Nonpriority,
            priority: false,
            ..base_job()
        };
        let batch = collector.collect(nonpriority).await.expect("ok");
        assert!(batch.items.is_empty());

        let late = CollectJob {
            late_sweep: true,
            providers: Vec::new(),
            jackett_indexers: Vec::new(),
            dubbed_only: false,
            mico_default: false,
            ..base_job()
        };
        let batch = collector.collect(late).await.expect("ok");
        assert!(batch.items.is_empty());
    }

    #[tokio::test]
    async fn disabled_fail_open_vazio() {
        let cfg = MicoConfig {
            enabled: false,
            ..Default::default()
        };
        let client = MicoClient::new(cfg).expect("client");
        let collector = MicoCollector::new(client);
        let batch = collector.collect(base_job()).await.expect("ok");
        assert!(batch.items.is_empty());
        assert!(!batch.partial);
    }
}
