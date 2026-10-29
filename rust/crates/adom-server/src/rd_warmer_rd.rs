//! Lado de PRODUÇÃO do `rd_warmer`: réguas, montagem e helpers de env.
//!
//! A credencial mora em `rd_warmer_accounts.rs`, o ledger em
//! `rd_warmer_ledger.rs` e a sonda HTTP em `rd_warmer_probe.rs`; aqui fica só a
//! costura que o boot chama.
//!
//! # Gate único
//!
//! O `RdGateExecutor` vem de `autofetch::shared_gate()` — a MESMA instância que
//! a fábrica do worker usa. Um `RdGateExecutor::new` aqui daria dois
//! serializadores para a mesma conta e o AIMD mentiria sobre gap/cooldown.

use std::sync::atomic::AtomicI64;
use std::sync::Arc;

use adom_index::NativeKv;

use super::magnet::MagnetDb;
use super::store::{NativeQueue, WarmIntentStore};
use super::{WarmDeps, Warmer};

#[path = "rd_warmer_accounts.rs"]
mod accounts;
#[path = "rd_warmer_ledger.rs"]
mod ledger;
use accounts::OperatorAccounts;
use ledger::KvLedger;

#[path = "rd_warmer_probe.rs"]
mod probe;

#[cfg(test)]
#[path = "rd_warmer_accounts_tests.rs"]
mod accounts_tests;

#[cfg(test)]
#[path = "rd_warmer_ledger_tests.rs"]
mod ledger_tests;

#[cfg(test)]
pub(super) use probe::GateWarm;

/// Réguas do aquecedor (`DEBRID_RD_WARM*`, mesmos defaults do Node).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WarmConfig {
    /// Hashes sondados por rodada (`DEBRID_RD_WARM_BATCH`).
    pub(crate) batch: usize,
    /// Profundidade da fila (`DEBRID_RD_WARM_QUEUE_MAX`).
    pub(crate) queue_max: usize,
    /// Sondas por hora civil (`DEBRID_RD_WARM_MAX_HOUR`, `0` desliga).
    pub(crate) max_per_hour: i64,
    /// Espera entre as tentativas de `/torrents/info`.
    pub(crate) poll_ms: u64,
    /// Intervalo do tick ocioso (`DEBRID_RD_WARM_INTERVAL_MS`).
    pub(crate) interval_ms: u64,
    /// Janela sem `/stream` para trabalhar (`DEBRID_RD_WARM_IDLE_WINDOW_MS`).
    pub(crate) idle_window_ms: i64,
}

impl WarmConfig {
    /// `None` = kill-switch desligado (`DEBRID_RD_WARM`).
    pub(crate) fn from_env() -> Option<Self> {
        if !env_flag("DEBRID_RD_WARM") {
            return None;
        }
        Some(Self {
            batch: env_num("DEBRID_RD_WARM_BATCH", 10).clamp(1, 100) as usize,
            queue_max: env_num("DEBRID_RD_WARM_QUEUE_MAX", 5_000).clamp(1, 100_000) as usize,
            max_per_hour: env_num("DEBRID_RD_WARM_MAX_HOUR", 300).max(0),
            poll_ms: env_num("DEBRID_RD_WARM_POLL_MS", 700).clamp(1, 10_000) as u64,
            // 1 s é o piso: um timer de 1 ms martelaria o banco sem produzir.
            interval_ms: env_num("DEBRID_RD_WARM_INTERVAL_MS", 30_000).clamp(1_000, 3_600_000)
                as u64,
            idle_window_ms: env_num("DEBRID_RD_WARM_IDLE_WINDOW_MS", 120_000).max(0),
        })
    }

    #[cfg(test)]
    pub(crate) fn fixture(batch: usize, queue_max: usize, max_per_hour: i64) -> Self {
        Self {
            batch,
            queue_max,
            max_per_hour,
            poll_ms: 1,
            interval_ms: 1_000,
            idle_window_ms: 120_000,
        }
    }
}

/// Produção: KV compartilhado + gate do autofetch + cofre do processo.
pub(crate) fn register(last_stream_ms: Option<Arc<AtomicI64>>) -> Option<Arc<Warmer>> {
    let config = WarmConfig::from_env()?;
    let kv = NativeKv::open(&adom_store::default_cache_db_path())
        .map(Arc::new)
        .map_err(|err| eprintln!("[warmer] cache.db indisponível ({err}); fila/intent em RAM"))
        .ok();
    let key = Arc::new(OperatorAccounts::new(
        crate::autofetch::shared_vault(),
        kv.clone(),
    ));
    let intent = Arc::new(WarmIntentStore::new(kv.clone()));
    let port = probe::port(config.poll_ms, crate::autofetch::shared_gate(), intent)?;
    let traffic =
        last_stream_ms.map(|last| crate::harvest::StreamTraffic::new(last, config.idle_window_ms));
    let warmer = Warmer::with_deps(WarmDeps {
        config,
        key,
        port,
        ledger: Arc::new(KvLedger::from_env()),
        magnet: Arc::new(MagnetDb::from_env()),
        queue: Arc::new(NativeQueue::new(kv)),
        traffic,
    });
    // Reparo do dano histórico roda no boot, mesmo sem fila.
    let cleared = warmer.scan_blocked_bads();
    warmer.start_ticker();
    eprintln!(
        "[warmer] rd_warmer nativo ligado (lote {}, fila {}, intervalo {} ms, ocioso {} ms, bads recuperados {cleared})",
        config.batch, config.queue_max, config.interval_ms, config.idle_window_ms
    );
    Some(warmer)
}

pub(super) fn env_flag(key: &str) -> bool {
    env_flag_default(key, true)
}

pub(super) fn env_flag_default(key: &str, default: bool) -> bool {
    std::env::var(key)
        .map(|raw| raw.trim() == "true")
        .unwrap_or(default)
}

pub(super) fn env_num(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

pub(super) fn env_text(key: &str) -> String {
    std::env::var(key).unwrap_or_default().trim().to_string()
}
