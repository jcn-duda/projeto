//! Lado de PRODUÇÃO do `rd_warmer`: réguas, cofre, ledger `rdc:v2` e montagem.
//!
//! A sonda HTTP (`RealDebridAutofetch` + gate AIMD) mora em `rd_warmer_probe.rs`;
//! aqui ficam as peças que falam KV e cofre.

use std::sync::{Arc, Mutex, PoisonError};

use adom_core::{
    ledger_key, next_on_blocked, next_on_hit, next_on_miss, normalize_hash, peek_state,
};
use adom_index::NativeKv;
use serde_json::{json, Value};

use super::{LedgerMark, WarmKey, WarmLedger, WarmSignal, Warmer};
use crate::autofetch::Vault;

#[path = "rd_warmer_probe.rs"]
mod probe;

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
    /// Profundidade da fila em RAM (`DEBRID_RD_WARM_QUEUE_MAX`).
    pub(crate) queue_max: usize,
    /// Sondas por hora civil (`DEBRID_RD_WARM_MAX_HOUR`, `0` desliga).
    pub(crate) max_per_hour: i64,
    /// Espera entre as tentativas de `/torrents/info`.
    pub(crate) poll_ms: u64,
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
        })
    }

    #[cfg(test)]
    pub(crate) fn fixture(batch: usize, queue_max: usize, max_per_hour: i64) -> Self {
        Self {
            batch,
            queue_max,
            max_per_hour,
            poll_ms: 1,
        }
    }
}

/// Produção: cofre do processo + ledger do `cache.db` + sonda com gate.
pub(crate) fn register() -> Option<Arc<Warmer>> {
    register_with(crate::autofetch::shared_vault(), None)
}

/// `scope` é `realdebrid:sha256(chave)` do cofre. O seam do tail ainda não
/// entrega o escopo ao sink, então a fiação do registro passa por aqui.
pub(crate) fn register_with(
    vault: Option<Arc<Vault>>,
    scope: Option<String>,
) -> Option<Arc<Warmer>> {
    let config = WarmConfig::from_env()?;
    let port = probe::port(config.poll_ms)?;
    let warmer = Warmer::new(
        config,
        Arc::new(VaultKey::new(vault, scope)),
        port,
        Arc::new(KvLedger::from_env()),
    );
    eprintln!(
        "[warmer] rd_warmer nativo ligado (lote {}, fila {})",
        config.batch, config.queue_max
    );
    Some(warmer)
}

pub(super) fn env_flag(key: &str) -> bool {
    std::env::var(key)
        .map(|raw| raw.trim() == "true")
        .unwrap_or(true)
}

pub(super) fn env_num(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

fn env_num_f(key: &str, default: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|value| *value >= 0.0)
        .unwrap_or(default)
}

// ---------------------------------------------------------------------------
// Cofre: a chave vem de `Vault::key`, nunca do payload.
// ---------------------------------------------------------------------------

/// Escopo aprendido do cofre (`realdebrid:sha256(chave)`). Sem escopo não há
/// `Vault::key`: o lote é descartado com contador, nunca com pânico.
pub(super) struct VaultKey {
    vault: Option<Arc<Vault>>,
    scope: Mutex<Option<String>>,
}

impl VaultKey {
    pub(super) fn new(vault: Option<Arc<Vault>>, scope: Option<String>) -> Self {
        let key = Self {
            vault,
            scope: Mutex::new(None),
        };
        if let Some(scope) = scope {
            key.learn(&scope);
        }
        key
    }

    /// Só escopo do Real-Debrid entra: outro serviço no cofre não é esta conta.
    #[allow(dead_code)]
    pub(super) fn learn(&self, scope: &str) {
        if !scope.starts_with("realdebrid:") {
            return;
        }
        *self.scope.lock().unwrap_or_else(PoisonError::into_inner) = Some(scope.to_string());
    }
}

impl WarmKey for VaultKey {
    fn rd_key(&self, now_ms: i64) -> Option<String> {
        let scope = self
            .scope
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()?;
        self.vault.as_deref()?.key(&scope, now_ms)
    }

    /// O seam do tail entrega o escopo do `encoded` da busca; só conta RD entra.
    fn learn(&self, scope: &str) {
        VaultKey::learn(self, scope);
    }
}

// ---------------------------------------------------------------------------
// Ledger `rdc:v2` — MESMA chave e forma `{s,at,n}` do veredito nativo.
// ---------------------------------------------------------------------------

pub(super) struct KvLedger {
    kv: Option<Arc<NativeKv>>,
    enabled: bool,
    hit_ttl_s: f64,
    blocked_ttl_s: f64,
    backoff_ms: Vec<f64>,
}

impl KvLedger {
    pub(super) fn from_env() -> Self {
        let kv = NativeKv::open(&adom_store::default_cache_db_path())
            .map(Arc::new)
            .map_err(|err| eprintln!("[warmer] ledger rdc:v2 indisponível ({err}); sem hits"))
            .ok();
        Self {
            kv,
            enabled: env_flag("DEBRID_RD_LEDGER"),
            hit_ttl_s: env_num_f("DEBRID_RD_LEDGER_HIT_TTL", 2_592_000.0),
            blocked_ttl_s: env_num_f("DEBRID_RD_LEDGER_BLOCKED_TTL", 2_592_000.0),
            backoff_ms: env_list(
                "DEBRID_RD_LEDGER_MISS_BACKOFF_MS",
                &[1_800_000.0, 7_200_000.0, 43_200_000.0, 259_200_000.0],
            ),
        }
    }

    #[cfg(test)]
    pub(super) fn memory() -> Self {
        Self {
            kv: Some(Arc::new(NativeKv::open_memory().expect("kv em memória"))),
            enabled: true,
            hit_ttl_s: 2_592_000.0,
            blocked_ttl_s: 2_592_000.0,
            backoff_ms: vec![1_800_000.0, 7_200_000.0],
        }
    }

    fn stored_state(&self, kv: &NativeKv, hash: &str, now_ms: i64) -> String {
        let value = kv.get_json(&ledger_key(hash), now_ms).ok().flatten();
        let state = value
            .as_ref()
            .and_then(|value| value.get("s"))
            .and_then(Value::as_str);
        peek_state(true, state).to_string()
    }

    fn prior(&self, kv: &NativeKv, hash: &str, now_ms: i64) -> (Option<String>, Option<f64>) {
        let Some(value) = kv.get_json(&ledger_key(hash), now_ms).ok().flatten() else {
            return (None, None);
        };
        (
            value.get("s").and_then(Value::as_str).map(str::to_string),
            value.get("n").and_then(Value::as_f64),
        )
    }
}

impl WarmLedger for KvLedger {
    fn state(&self, hash: &str, now_ms: i64) -> LedgerMark {
        let Some(kv) = self.kv.as_deref().filter(|_| self.enabled) else {
            return LedgerMark::Other;
        };
        if normalize_hash(hash).is_empty() {
            return LedgerMark::Other;
        }
        match self.stored_state(kv, hash, now_ms).as_str() {
            "hit" => LedgerMark::Hit,
            "blocked" => LedgerMark::Blocked,
            _ => LedgerMark::Other,
        }
    }

    fn note(&self, hash: &str, signal: WarmSignal, now_ms: i64) {
        let Some(kv) = self.kv.as_deref().filter(|_| self.enabled) else {
            return;
        };
        // Mesma unidade do `verdict_ledger` nativo (`at` em segundos).
        let now = now_ms as f64 / 1000.0;
        let current = self.stored_state(kv, hash, now_ms);
        let write = match signal {
            WarmSignal::Hit => next_on_hit(true, self.hit_ttl_s, now, &current),
            WarmSignal::Blocked => next_on_blocked(true, hash, self.blocked_ttl_s, now),
            WarmSignal::Miss => {
                let (prior_s, prior_n) = self.prior(kv, hash, now_ms);
                next_on_miss(
                    true,
                    hash,
                    &self.backoff_ms,
                    now,
                    &current,
                    prior_s.as_deref(),
                    prior_n,
                )
            }
        };
        let Some(write) = write else {
            return;
        };
        let target = write.hash.clone().unwrap_or_else(|| normalize_hash(hash));
        if target.is_empty() {
            return;
        }
        let value = json!({ "s": write.s, "at": num(write.at), "n": num(write.n) });
        let ttl_seconds = write.ttl_seconds.ceil() as i64;
        if let Err(err) = kv.put_json(&ledger_key(&target), &value, ttl_seconds, now_ms) {
            eprintln!("[warmer] ledger rdc:v2 não gravou: {err}");
        }
    }
}

/// Número na forma do Node: inteiro vira `0`/`1`, não `0.0`/`1.0`.
fn num(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= i64::MAX as f64 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn env_list(key: &str, default: &[f64]) -> Vec<f64> {
    let parsed: Vec<f64> = std::env::var(key)
        .map(|raw| {
            raw.split(',')
                .filter_map(|item| item.trim().parse::<f64>().ok())
                .filter(|value| *value >= 0.0)
                .collect()
        })
        .unwrap_or_default();
    if parsed.is_empty() {
        default.to_vec()
    } else {
        parsed
    }
}
