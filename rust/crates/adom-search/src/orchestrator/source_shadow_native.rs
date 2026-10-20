//! Montagem dos coletores NATIVOS da sombra (extraído de `source_shadow.rs`
//! pela catraca de 400 linhas).
//!
//! Fonte com sombra precisa da MESMA identidade de indexer do Node (F2.1
//! Jackett, F2.2 Prowlarr, F2.3 Torrentio, F2.4 Mico, F2.5 BLUDV). O Jackett
//! entra em modo sombra (ignora breaker e não registra status);
//! Prowlarr/Torrentio/Mico/BLUDV não têm status e usam o cliente normal em modo
//! read-only — Torrentio/Mico ignoram o breaker e não o abrem/resetam, e o
//! BLUDV não toca o `raw:v1` (`SOURCES_RUST=<fonte>` continua sendo o único
//! caminho vivo que alimenta circuito/cache).

use std::sync::Arc;

use crate::orchestrator::bludv_collector::BludvCollector;
use crate::orchestrator::collect::Collector;
use crate::orchestrator::jackett_collector::JackettCollector;
use crate::orchestrator::mico_collector::MicoCollector;
use crate::orchestrator::prowlarr_collector::ProwlarrCollector;
use crate::orchestrator::torrentio_collector::TorrentioCollector;

/// Coletor nativo da sombra + o override de indexers do `NodeCollector`.
pub(crate) struct NativeShadow {
    pub(crate) collector: Arc<dyn Collector>,
    /// `Some` só para o Jackett (`JACKETT_INDEXERS` do processo); `None` para
    /// fontes que não têm indexers (Prowlarr/Torrentio/Mico/BLUDV) — aí a
    /// referência usa o `ji` do job, sem override.
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
        "mico" => {
            // O breaker do Mico também é por cliente: a sombra cria o próprio
            // e o mantém intocado (read-only).
            let collector = MicoCollector::from_env()
                .map_err(|err| format!("MicoClient: {err}"))?
                .with_shadow(true);
            Ok(NativeShadow {
                collector: Arc::new(collector),
                indexers: None,
            })
        }
        "bludv" => {
            // Cliente PRÓPRIO da sombra e SEM `raw:v1`: `read_only` não lê nem
            // grava o cache bruto (mesmo contrato do `bludv.search` do Node).
            let collector = BludvCollector::from_env()
                .map_err(|err| format!("BludvClient: {err}"))?
                .with_shadow(true);
            Ok(NativeShadow {
                collector: Arc::new(collector),
                indexers: None,
            })
        }
        other => Err(format!("fonte sem sombra: {other}")),
    }
}
