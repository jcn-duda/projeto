//! Contadores do cache de streams no caminho do usuário (`streams:v21`).
//!
//! Mede o que a ROTA do `/stream` serviu — hit fresco, hit expirado dentro
//! da graça (stale-while-revalidate) e miss — e as ESCRITAS que entraram no
//! store (`set_fenced` OK do commit e da promoção tardia; a reescrita do
//! passe tardio é escrita de propósito e conta como write). Leitores de
//! fundo (`refresh.rs`) e o `/streams/trace` não contam: a régua aqui é o
//! hit-rate REAL percebido por quem pediu a lista.
//!
//! Exposto por [`stream_cache_metrics_snapshot`]; a rota `GET /streams/stats`
//! da admin do gateway o consome e acrescenta o `hitRate`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

pub const HIT: &str = "stream.cache.hit";
/// Expirado DENTRO da graça: servido na hora enquanto revalida em fundo.
pub const STALE_SERVED: &str = "stream.cache.stale_served";
pub const MISS: &str = "stream.cache.miss";
/// `set_fenced` OK (commit da busca e promoção tardia): cada gravação é 1.
pub const WRITE: &str = "stream.cache.write";

const KEYS: &[&str] = &[HIT, STALE_SERVED, MISS, WRITE];

/// Contadores do cache de streams. `Clone` barato (`Arc<Mutex<..>>`).
#[derive(Clone, Default)]
pub struct StreamCacheMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl StreamCacheMetrics {
    pub fn new() -> Self {
        let metrics = Self::default();
        let _ = metrics.snapshot();
        metrics
    }

    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        for key in KEYS {
            guard.entry((*key).to_string()).or_insert(0);
        }
        guard.clone()
    }

    pub fn inc(&self, key: &str, by: u64) {
        if by == 0 {
            return;
        }
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.entry(key.to_string()).or_insert(0);
        *entry = (*entry).saturating_add(by);
    }

    #[cfg(test)]
    pub fn get(&self, key: &str) -> u64 {
        self.snapshot().get(key).copied().unwrap_or(0)
    }
}

static GLOBAL: OnceLock<StreamCacheMetrics> = OnceLock::new();

pub(super) fn global_metrics() -> &'static StreamCacheMetrics {
    GLOBAL.get_or_init(StreamCacheMetrics::new)
}

/// Snapshot das métricas `stream.cache.*` para a admin do gateway.
pub fn stream_cache_metrics_snapshot() -> BTreeMap<String, u64> {
    global_metrics().snapshot()
}

/// Hit-rate REAL do cache no caminho do usuário: `(hit + staleServed) /
/// (hit + staleServed + miss)`. `None` sem NENHUMA consulta (nada dividido
/// por zero) — a rota serializa como `null`.
pub fn hit_rate(snapshot: &BTreeMap<String, u64>) -> Option<f64> {
    let of = |key: &str| snapshot.get(key).copied().unwrap_or(0);
    let served = of(HIT).saturating_add(of(STALE_SERVED));
    let total = served.saturating_add(of(MISS));
    (total > 0).then_some(served as f64 / total as f64)
}

#[cfg(test)]
#[path = "stream_cache_metrics_tests.rs"]
mod tests;
