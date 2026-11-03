//! Boot recovery e foto por site para o painel — saíram do `loop.rs` pela
//! catraca de 400 linhas. O `impl CrawlMotor` vale aqui: os campos tocados são
//! `pub(super)` (mesmo módulo `motor`) e nenhum contrato muda.

use crate::site_profiles::all_site_ids;

use super::r#loop::{with_store, CrawlMotor};
use super::types::SiteStatus;

impl CrawlMotor {
    /// Crash recovery: URLs presas em `inflight` voltam para a fila.
    pub(super) async fn requeue_inflight_on_boot(&self) {
        let handle = self.store.clone();
        let sites = all_site_ids();
        let total = with_store(handle, move |db| {
            sites
                .iter()
                .try_fold(0u32, |acc, id| db.requeue_inflight(id).map(|n| acc + n))
        })
        .await
        .unwrap_or(0);
        if total > 0 {
            eprintln!("[motor] recovery: {total} URLs inflight voltaram para a fila");
        }
    }

    /// Contadores por site para o painel — uma única ida ao thread blocking.
    pub(super) async fn snapshot_sites(&self) -> Vec<SiteStatus> {
        if self.ensure_store().is_err() {
            return Vec::new();
        }
        let ids = all_site_ids();
        with_store(self.store.clone(), move |db| {
            Ok(ids
                .iter()
                .filter_map(|id| {
                    let c = db.counters(id).ok()?;
                    Some(SiteStatus {
                        site_id: (*id).to_string(),
                        pending: c.pending,
                        done: c.done,
                        no_torrent: c.no_torrent,
                        error: c.error,
                        inflight: c.inflight,
                        releases: db.sum_releases(id).unwrap_or(0),
                        gate_pending: c.gate_pending,
                    })
                })
                .collect())
        })
        .await
        .unwrap_or_default()
    }
}
