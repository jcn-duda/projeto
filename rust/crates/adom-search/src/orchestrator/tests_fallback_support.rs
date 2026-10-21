//! Suporte dos testes da reserva 📦. A leitura é NATIVA: o dublê é um
//! `MagnetBankSource` com as mesmas linhas que a antiga rota Node devolvia.

use std::collections::BTreeMap;
use std::sync::Arc;

use adom_core::{InstantMagnet, InstantSource, InstantWork};

use super::test_support::*;
use crate::orchestrator::live_state::{LiveAllState, LiveBatchState};

pub(super) const FALLBACK_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

pub(super) fn wall_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(super) fn live(failed: &[&str], pending: &[&str], empty: &[&str]) -> LiveBatchState {
    LiveBatchState {
        failed: failed.iter().map(|s| s.to_string()).collect(),
        pending: pending.iter().map(|s| s.to_string()).collect(),
        empty: empty.iter().map(|s| s.to_string()).collect(),
        all: LiveAllState::Ok,
    }
}

/// Coletor que devolve o MESMO lote vivo para qualquer task (o build deduplica
/// por hash). É o mínimo para o estado `failed` chegar ao `first_live`.
pub(super) struct LiveCollector {
    pub(super) items: Vec<RawItem>,
    pub(super) live: LiveBatchState,
}

impl Collector for LiveCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            Ok(CollectBatch {
                items: self.items.clone(),
                partial: false,
                live: Some(self.live.clone()),
            })
        })
    }
}

/// Banco nativo com a MESMA reserva que a antiga rota devolvia: uma obra
/// elegível (`passed_filter = 1`) com fonte `bludv` permitida.
pub(super) fn fallback_bank() -> Arc<StubBank> {
    let hash = FALLBACK_HASH.to_string();
    let mut sources = BTreeMap::new();
    sources.insert(
        hash.clone(),
        vec![InstantSource {
            indexer: "bludv".into(),
            tracker: "BLUDV".into(),
            last_seen: 10,
            allowed: true,
        }],
    );
    StubBank::new(
        vec![InstantWork {
            hash: hash.clone(),
            passed_filter: 1,
            last_seen: 10,
            first_seen: 5,
            magnet: Some(InstantMagnet {
                hash: hash.clone(),
                uri: format!("magnet:?xt=urn:btih:{hash}"),
                title: "Filme Teste 2024 1080p Dublado (Banco)".into(),
                size: 1024,
                is_br: true,
                dubbed: true,
                quality: "1080p".into(),
                seeders_max: 9,
                seeders_last: 7,
                last_seen: 10,
                lied: false,
            }),
        }],
        sources,
    )
}
