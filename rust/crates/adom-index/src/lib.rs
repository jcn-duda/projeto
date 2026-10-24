//! Índice de releases `idx:v14` no `cache.db` compartilhado com o Node.
//!
//! Crate leve de propósito: depende só de `adom-core` e `rusqlite`, sem o
//! stack de rede do `adom-search`. Assim o `.node` (adom-napi) e o gateway
//! (adom-store) usam o MESMO store, sem o `.node` embarcar `reqwest`/`tokio`.

mod raw;
mod release_index;

pub use raw::{default_raw_quota, is_raw_key, raw_prefix, RawCacheStore};
pub use release_index::{
    default_cache_db_path, idx_prefix, BankLookup, FileEvidence, IndexEntry, IndexedRelease,
    RecordOptions, ReleaseIndexStore, IDX_NAMESPACE,
};
