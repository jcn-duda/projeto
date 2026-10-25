//! Stores SQLite do gateway.
//!
//! `streams:v21` (embrião da Fase D) espelha o padrão de `adom-debrid::store`
//! (rusqlite, WAL, tabela `cache`, cota por prefixo com despejo do que expira
//! primeiro), mas a semântica de leitura é a do SWR em `adom-search::cache`:
//! `get` é duro; `get_with_stale` serve dentro da graça sem apagar.
//!
//! `raw:v1` (coletor BLUDV nativo) usa o MESMO `cache.db` do Node e a mesma
//! chave/valor (`raw:v1:bludv:d|t:<q>` / `{"items":[…]}`): é o cache bruto
//! compartilhado, lido/gravado só no caminho vivo (coletor BLUDV nativo).
//!
//! O gateway (`adom-server`) abre o streams via `STREAMS_DB` (default
//! `data/streams.db`) e o raw via `CACHE_DB_PATH` (default `data/cache.db`).

mod index_impl;
pub use index_impl::NativeReleaseIndex;
// KV nativo do estado que o Rust passou a possuir (fila/estado do Chupim,
// posse/proteção do AllDebrid) na MESMA tabela `cache` do `data/cache.db`.
// Mora no `adom-index` (crate leve) para o `.node` alcançar sem dependência
// nova; aqui é só o caminho antigo de quem já importa de `adom-store`.
pub use adom_index::kv;
pub use adom_index::NativeKv;
mod magnet_bank;
mod magnet_db;
mod meta;
mod raw;
mod streams;

pub use adom_index::{
    default_cache_db_path as default_index_cache_db_path, default_raw_quota, idx_prefix,
    is_raw_key, raw_prefix, FileEvidence, IndexEntry, IndexedRelease, RawCacheStore, RecordOptions,
    ReleaseIndexStore, IDX_NAMESPACE,
};
pub use magnet_bank::{magnet_db_path, MagnetBankStore, WorkCtx};
pub use magnet_db::{
    default_cache_db_path as default_magnet_db_cache_path, mag_prefix, mark_key, MagnetDbStore,
};
pub use meta::{default_cache_db_path, meta_namespace, MetaCacheStore};
pub use raw::raw_store_from_env;
pub use streams::{
    default_streams_quota, is_streams_key, streams_prefix, StreamsStore, TraceHit,
    STREAMS_NAMESPACE,
};
