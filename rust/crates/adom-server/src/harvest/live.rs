//! Config AO VIVO do colhedor: o overlay que o painel grava no Node.
//!
//! O Node continua dono do formulário (`src/utils/harvester-live.ts`, schema e
//! clamps em `harvester-live-schema.ts`) e persiste os overrides em
//! `cfg:v1:harvester`, no MESMO `cache.db`. Antes desta ponte o gateway só lia
//! o `.env`: o painel respondia `ok:true` e o colhedor seguia com o teto, o
//! intervalo e a pausa antigos.
//!
//! Dois caminhos, mesmo parse:
//! - boot: o gateway lê a linha do disco (ajuste e pausa sobrevivem ao restart);
//! - ao vivo: o Node empurra os overrides em `POST /harvest/config` a cada
//!   `set`/`reset`/pausa — sem polling do disco.
//!
//! Override ausente = valor do `.env` do gateway (os nomes são os mesmos do
//! Node). `paused` ausente = retomado, como o `effective()` do TS.

use adom_harvest::HarvestStore;
use serde_json::Value;

use super::config::HarvestConfig;

/// `${prefix('cfg')}harvester` do Node.
pub(crate) const LIVE_KEY: &str = "cfg:v1:harvester";

/// Overrides do painel já tipados; `None` = sem override (vale o `.env`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct LiveOverlay {
    enabled: Option<bool>,
    max_per_hour: Option<u32>,
    idle_window_ms: Option<i64>,
    interval_ms: Option<u64>,
    queue_max: Option<usize>,
    drain_max_works: Option<usize>,
    indexer_delay_ms: Option<u64>,
    entry_ttl: Option<u64>,
    br_first: Option<bool>,
    br_max_wait_ms: Option<i64>,
    pub(crate) paused: bool,
}

impl LiveOverlay {
    /// Objeto de overrides do Node. Campo ilegível vira ausente: o Node já
    /// clampeia na escrita, e um valor torto no disco não pode derrubar o `.env`.
    pub(crate) fn from_value(value: &Value) -> Self {
        let num = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n >= 0.0)
        };
        let flag = |key: &str| value.get(key).and_then(Value::as_bool);
        Self {
            enabled: flag("harvestEnabled"),
            max_per_hour: num("harvestMaxPerHour").map(|n| n as u32),
            idle_window_ms: num("harvestIdleWindowMs").map(|n| n as i64),
            interval_ms: num("harvestIntervalMs").map(|n| n as u64),
            queue_max: num("harvestQueueMax").map(|n| n as usize),
            drain_max_works: num("harvestDrainMaxWorks").map(|n| (n as usize).max(1)),
            indexer_delay_ms: num("harvestIndexerDelayMs").map(|n| n as u64),
            entry_ttl: num("harvestEntryTtl").map(|n| n as u64),
            br_first: flag("harvestBrFirst"),
            br_max_wait_ms: num("harvestBrMaxWaitMs").map(|n| n as i64),
            paused: flag("paused").unwrap_or(false),
        }
    }

    /// Linha do disco; ausente, vencida ou ilegível = sem overlay.
    pub(crate) fn load(store: &HarvestStore, now_ms: i64) -> Option<Self> {
        let raw = store.get_value(LIVE_KEY, now_ms).ok()??;
        let value: Value = serde_json::from_str(&raw).ok()?;
        value.is_object().then(|| Self::from_value(&value))
    }

    /// `.env` do gateway + overrides. `queue_preview` e o prazo index-only não
    /// estão no schema do painel e ficam com o `.env`.
    pub(crate) fn apply(&self, env: &HarvestConfig) -> HarvestConfig {
        HarvestConfig {
            enabled: self.enabled.unwrap_or(env.enabled),
            interval_ms: self.interval_ms.unwrap_or(env.interval_ms),
            idle_window_ms: self.idle_window_ms.unwrap_or(env.idle_window_ms),
            max_per_hour: self.max_per_hour.unwrap_or(env.max_per_hour),
            indexer_delay_ms: self.indexer_delay_ms.unwrap_or(env.indexer_delay_ms),
            queue_max: self.queue_max.unwrap_or(env.queue_max),
            entry_ttl: self.entry_ttl.unwrap_or(env.entry_ttl),
            drain_max_works: self.drain_max_works.unwrap_or(env.drain_max_works),
            br_first: self.br_first.unwrap_or(env.br_first),
            br_max_wait_ms: self.br_max_wait_ms.unwrap_or(env.br_max_wait_ms),
            ..env.clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn sem_override_vale_o_env() {
        let env = HarvestConfig::default();
        let overlay = LiveOverlay::from_value(&json!({}));
        assert_eq!(overlay.apply(&env), env);
        assert!(!overlay.paused);
    }

    #[test]
    fn override_do_painel_vence_o_env() {
        let env = HarvestConfig::default();
        let overlay = LiveOverlay::from_value(&json!({
            "harvestEnabled": false,
            "harvestMaxPerHour": 7,
            "harvestIntervalMs": 300000,
            "harvestIdleWindowMs": 0,
            "harvestBrFirst": false,
            "paused": true,
            "pausedSince": 1792818793000_i64,
        }));
        let cfg = overlay.apply(&env);
        assert!(!cfg.enabled);
        assert_eq!(cfg.max_per_hour, 7);
        assert_eq!(cfg.interval_ms, 300_000);
        assert_eq!(cfg.idle_window_ms, 0);
        assert!(!cfg.br_first);
        assert!(overlay.paused);
        // Fora do schema do painel: sempre o `.env`.
        assert_eq!(cfg.queue_preview, env.queue_preview);
        assert_eq!(
            cfg.index_only_harvest_timeout_ms,
            env.index_only_harvest_timeout_ms
        );
    }

    #[test]
    fn valor_torto_cai_no_env() {
        let env = HarvestConfig::default();
        let overlay = LiveOverlay::from_value(&json!({
            "harvestMaxPerHour": "muitos",
            "harvestIntervalMs": -5,
            "harvestDrainMaxWorks": 0,
            "paused": "sim",
        }));
        let cfg = overlay.apply(&env);
        assert_eq!(cfg.max_per_hour, env.max_per_hour);
        assert_eq!(cfg.interval_ms, env.interval_ms);
        assert_eq!(cfg.drain_max_works, 1, "o drain nunca fica sem obra");
        assert!(!overlay.paused);
    }

    #[test]
    fn le_a_linha_que_o_node_grava() {
        let store = HarvestStore::open_memory().expect("store");
        let now = 1_000_000;
        assert!(LiveOverlay::load(&store, now).is_none());
        store
            .put_value(
                LIVE_KEY,
                r#"{"harvestMaxPerHour":9,"paused":true}"#,
                60,
                now,
            )
            .expect("grava");
        let overlay = LiveOverlay::load(&store, now).expect("overlay");
        assert!(overlay.paused);
        assert_eq!(overlay.apply(&HarvestConfig::default()).max_per_hour, 9);
    }
}
