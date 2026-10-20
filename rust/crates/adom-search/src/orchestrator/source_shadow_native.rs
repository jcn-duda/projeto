//! Montagem dos coletores NATIVOS da sombra (extraído de `source_shadow.rs`
//! pela catraca de 400 linhas).
//!
//! Fonte com sombra precisa da MESMA identidade de indexer do Node (F2.1
//! Jackett, F2.2 Prowlarr, F2.3 Torrentio). O Jackett entra em modo sombra
//! (ignora breaker e não registra status); Prowlarr/Torrentio não têm status e
//! usam o cliente normal em modo read-only — o do Torrentio ignora o breaker e
//! não o abre/reseta (`SOURCES_RUST=torrentio` continua sendo o único caminho
//! que alimenta o circuito).

use std::sync::Arc;

use crate::orchestrator::collect::Collector;
use crate::orchestrator::jackett_collector::JackettCollector;
use crate::orchestrator::prowlarr_collector::ProwlarrCollector;
use crate::orchestrator::torrentio_collector::TorrentioCollector;

/// Coletor nativo da sombra + o override de indexers do `NodeCollector`.
pub(crate) struct NativeShadow {
    pub(crate) collector: Arc<dyn Collector>,
    /// `Some` só para o Jackett (`JACKETT_INDEXERS` do processo); `None` para
    /// fontes que não têm indexers (Prowlarr/Torrentio) — aí a referência usa o
    /// `ji` do job, sem override.
    pub(crate) indexers: Option<Vec<String>>,
}

/// Coletor nativo da sombra.
pub(crate) fn native_collector(source: &str) -> Result<NativeShadow, String> {
    match source {
        "jackett" => {
            let collector = JackettCollector::from_env()
                .map_err(|err| format!("JackettClient: {err}"))?
                .with_shadow(true);
            let indexers = collector.client().config().indexers.clone();
            Ok(NativeShadow {
                collector: Arc::new(collector),
                indexers: Some(indexers),
            })
        }
        "prowlarr" => {
            let collector =
                ProwlarrCollector::from_env().map_err(|err| format!("ProwlarrClient: {err}"))?;
            Ok(NativeShadow {
                collector: Arc::new(collector),
                indexers: None,
            })
        }
        "torrentio" => {
            // Cliente PRÓPRIO da sombra: o breaker é por cliente, então o
            // circuito do caminho de resposta (`SOURCES_RUST=torrentio`) nem é
            // lido por aqui.
            let collector = TorrentioCollector::from_env()
                .map_err(|err| format!("TorrentioClient: {err}"))?
                .with_shadow(true);
            Ok(NativeShadow {
                collector: Arc::new(collector),
                indexers: None,
            })
        }
        other => Err(format!("fonte sem sombra: {other}")),
    }
}
