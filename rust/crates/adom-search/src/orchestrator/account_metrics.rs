//! Contadores próprios do inventário nativo da conta (F3).
//!
//! Nada aqui depende do Node: `account.rust.*` mede a leitura nativa, o
//! fast-path e os motivos de "não sei"; `account.node`/`account.fast_path*`
//! medem o caminho compartilhado com o Node.
//!
//! Exposto em `/metrics` do gateway por [`account_metrics_snapshot`].

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

pub const FETCH: &str = "account.rust.fetch";
pub const ITEMS: &str = "account.rust.items";
pub const EMPTY: &str = "account.rust.empty";
pub const KNOWN: &str = "account.rust.known";
pub const UNUSABLE_AUTH: &str = "account.rust.unusable_auth";
pub const UNUSABLE_QUOTA: &str = "account.rust.unusable_quota";
/// `known:false` sem `unusable` (rede/prazo/rate limit): "não sei".
pub const UNKNOWN: &str = "account.rust.unknown";
pub const MEMO_HIT: &str = "account.rust.memo_hit";
/// `ACCOUNT_RUST=on` sem fonte injetada: caiu na tarefa Node (degradação).
pub const SOURCE_MISSING: &str = "account.rust.source_missing";
/// A tarefa Node da conta rodou (modo off ou degradação).
pub const NODE: &str = "account.node";
pub const FAST_PATH: &str = "account.fast_path";
/// Lote da conta suficiente mas sem cobertura de dublado pedida.
pub const FAST_PATH_SKIPPED: &str = "account.fast_path.skipped";

const KEYS: &[&str] = &[
    FETCH,
    ITEMS,
    EMPTY,
    KNOWN,
    UNUSABLE_AUTH,
    UNUSABLE_QUOTA,
    UNKNOWN,
    MEMO_HIT,
    SOURCE_MISSING,
    NODE,
    FAST_PATH,
    FAST_PATH_SKIPPED,
];

/// Contadores do inventário da conta. `Clone` barato (`Arc<Mutex<..>>`).
#[derive(Clone, Default)]
pub struct AccountMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl AccountMetrics {
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
}

static GLOBAL: OnceLock<AccountMetrics> = OnceLock::new();

pub(super) fn global_metrics() -> &'static AccountMetrics {
    GLOBAL.get_or_init(AccountMetrics::new)
}

/// Snapshot das métricas `account.*` para a rota `/metrics` do gateway.
pub fn account_metrics_snapshot() -> BTreeMap<String, u64> {
    global_metrics().snapshot()
}
