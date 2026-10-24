//! `raw:v1` no gateway: o store mora no `adom-index` (crate leve, sem rede,
//! compartilhado com o `.node`); aqui ficam o `impl RawStore` (trait do
//! coletor BLUDV nativo) e a fiação de env (`CACHE_PERSIST`/`CACHE_DB_PATH`).

use adom_index::RawCacheStore;
use adom_sources::RawStore;
use serde_json::Value;

/// Newtype local: o `RawCacheStore` é do `adom-index`, então a orphan rule
/// impede implementar o trait do coletor (`RawStore`, do `adom-sources`)
/// direto nele. A casca não guarda estado — só carrega o tipo.
pub struct RawStoreHandle(RawCacheStore);

impl RawStoreHandle {
    pub fn open_memory() -> Result<Self, String> {
        RawCacheStore::open_memory().map(Self)
    }

    /// Linhas do namespace `raw` (diagnóstico).
    pub fn len(&self) -> Result<usize, String> {
        self.0.len()
    }

    /// Teto de linhas do namespace (cota L1 do `raw`).
    pub fn quota(&self) -> u64 {
        self.0.quota()
    }

    /// Par do `len`; o namespace vazio é o caso normal antes da 1ª coleta.
    pub fn is_empty(&self) -> Result<bool, String> {
        Ok(self.len()? == 0)
    }
}

impl RawStore for RawStoreHandle {
    fn get(&self, key: &str, now_ms: i64) -> Option<Value> {
        self.0.get_raw(key, now_ms).ok().flatten()
    }

    fn set(&self, key: &str, value: &Value, ttl_seconds: u64, now_ms: i64) {
        if let Err(err) = self.0.set_raw(key, value, ttl_seconds, now_ms) {
            eprintln!("[gateway] raw:v1 não gravou: {err}");
        }
    }
}

/// `CACHE_PERSIST=false` desliga o disco (`cache.ts` do Node); o handle sobe
/// só em memória. O caminho é `CACHE_DB_PATH`, default `data/cache.db`
/// (volume `docker-data/addon`).
pub fn raw_store_from_env() -> Result<RawStoreHandle, String> {
    if !cache_persist() {
        eprintln!("[gateway] CACHE_PERSIST=false; raw:v1 só em memória");
        return RawStoreHandle::open_memory();
    }
    RawCacheStore::open(&cache_db_path()).map(RawStoreHandle)
}

/// `String(process.env.CACHE_PERSIST || 'true') !== 'false'` do `cache.ts`:
/// QUALQUER valor diferente de "false" mantém o disco (inclusive vazio).
pub(crate) fn cache_persist() -> bool {
    std::env::var("CACHE_PERSIST")
        .map(|raw| !raw.trim().eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

/// `CACHE_DB_PATH` (default `data/cache.db`), compartilhado com o Node.
pub(crate) fn cache_db_path() -> std::path::PathBuf {
    std::env::var("CACHE_DB_PATH")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("data/cache.db"))
}

#[cfg(test)]
#[path = "raw_env_tests.rs"]
mod raw_env_tests;
