//! Snapshot `knownBefore` por conta (TTL, lease de refresh e fail-safe).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::alldebrid::AllDebrid;
use crate::error::now_ms;

use super::durable::DurablePeek;
use super::flags::PREEXISTING_TTL_ENV;
use super::holds::submitted;

const DEFAULT_PREEXISTING_TTL_MS: u64 = 300_000;

#[derive(Default)]
struct InventoryEntry {
    hashes: Option<Arc<HashSet<String>>>,
    loaded_at_ms: i64,
    loading: bool,
    loading_since_ms: i64,
}

/// Lease do refresh: um task abortado (runtime caindo/falha) não pode deixar a
/// conta travada em `loading` para sempre — passado o lease, a próxima busca
/// tenta de novo. É bem maior que um `/magnet/status` normal.
const LOADING_LEASE_MS: i64 = 60_000;

/// Snapshot por conta com TTL. Vencido = `None` (fail-safe fechado) e refresh
/// em fundo; a busca NUNCA espera o `/magnet/status`. É o mesmo contrato do
/// `knownBefore` do Node, com a diferença de que aqui o refresh não bloqueia.
pub struct Inventory {
    ttl: Duration,
    entries: Mutex<HashMap<String, InventoryEntry>>,
}

impl Inventory {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn from_env() -> Self {
        let ms = std::env::var(PREEXISTING_TTL_ENV)
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_PREEXISTING_TTL_MS);
        Self::new(Duration::from_millis(ms))
    }

    fn peek(&self, account: &str) -> Option<Arc<HashSet<String>>> {
        if self.ttl.is_zero() {
            return None;
        }
        let guard = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.get(account)?;
        let hashes = entry.hashes.clone()?;
        let fresh =
            (now_ms() as i64).saturating_sub(entry.loaded_at_ms) < self.ttl.as_millis() as i64;
        fresh.then_some(hashes)
    }

    fn begin(&self, account: &str) -> bool {
        let now = now_ms() as i64;
        let mut guard = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.entry(account.to_string()).or_default();
        if entry.loading && now.saturating_sub(entry.loading_since_ms) < LOADING_LEASE_MS {
            return false;
        }
        entry.loading = true;
        entry.loading_since_ms = now;
        true
    }

    fn finish(&self, account: &str, hashes: Option<HashSet<String>>) {
        let mut guard = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.entry(account.to_string()).or_default();
        entry.loading = false;
        match hashes {
            Some(hashes) => {
                entry.hashes = Some(Arc::new(hashes));
                entry.loaded_at_ms = now_ms() as i64;
            }
            None => {
                // Falha limpa a referência: a próxima tentativa recarrega.
                entry.hashes = None;
                entry.loaded_at_ms = 0;
            }
        }
    }

    async fn load_inner(
        &self,
        ad: &AllDebrid,
        api_key: &str,
        account: &str,
        durable: Option<&DurablePeek>,
    ) -> Option<HashSet<String>> {
        let hashes = ad.magnet_hashes(api_key).await.ok()?;
        Some(build_snapshot(account, hashes, durable))
    }

    /// Aguarda o snapshot (usado por testes e por caminhos de fundo). Em
    /// produção o `check` só faz `peek` + refresh em fundo.
    pub async fn load_now(
        &self,
        ad: &AllDebrid,
        api_key: &str,
        account: &str,
        durable: Option<&DurablePeek>,
    ) -> Option<Arc<HashSet<String>>> {
        if !self.begin(account) {
            return None;
        }
        let hashes = self.load_inner(ad, api_key, account, durable).await;
        self.finish(account, hashes);
        self.peek(account)
    }
}

/// Snapshot = conta menos a posse provada (`adsub` durável e `submitted` desta
/// instância). O que sobra é acervo do usuário e não sai.
fn build_snapshot(
    account: &str,
    hashes: Vec<String>,
    durable: Option<&DurablePeek>,
) -> HashSet<String> {
    let now = now_ms() as i64;
    let owned = durable
        .map(|peek| peek.owned_hashes(account, now))
        .unwrap_or_default();
    let mut snapshot: HashSet<String> = hashes
        .into_iter()
        .map(|hash| hash.trim().to_lowercase())
        .filter(|hash| !hash.is_empty())
        .collect();
    for hash in submitted().hashes(account) {
        snapshot.remove(&hash);
    }
    for hash in owned {
        snapshot.remove(&hash);
    }
    snapshot
}

static INVENTORY: OnceLock<Inventory> = OnceLock::new();

pub fn inventory() -> &'static Inventory {
    INVENTORY.get_or_init(Inventory::from_env)
}

/// Snapshot vigente (peek). `None` = sem referência autorizada nesta rodada.
pub fn known_before(account: &str) -> Option<Arc<HashSet<String>>> {
    inventory().peek(account)
}

/// Dispara o refresh em fundo se o snapshot venceu. Nunca bloqueia a busca e
/// nunca decide nada sozinho: esta rodada segue fail-closed.
pub fn refresh_known_before(
    ad: &AllDebrid,
    api_key: &str,
    account: &str,
    durable: Option<Arc<DurablePeek>>,
) -> bool {
    let inv = inventory();
    if inv.peek(account).is_some() || !inv.begin(account) {
        return false;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        inv.finish(account, None);
        return false;
    };
    let ad = ad.clone();
    let key = api_key.to_string();
    let account = account.to_string();
    handle.spawn(async move {
        let inv = inventory();
        let hashes = inv
            .load_inner(&ad, &key, &account, durable.as_deref())
            .await;
        inv.finish(&account, hashes);
    });
    true
}
