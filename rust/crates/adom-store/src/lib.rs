//! Stores SQLite do gateway.
//!
//! `streams:v21` (embrião da Fase D) espelha o padrão de `adom-debrid::store`
//! (rusqlite, WAL, tabela `cache`, cota por prefixo com despejo do que expira
//! primeiro), mas a semântica de leitura é a do SWR em `adom-search::cache`:
//! `get` é duro; `get_with_stale` serve dentro da graça sem apagar.
//!
//! `raw:v1` (coletor BLUDV nativo) usa o MESMO `cache.db` do Node e a mesma
//! chave/valor (`raw:v1:bludv:d|t:<q>` / `{"items":[…]}`): é o cache bruto
//! compartilhado, lido/gravado só no caminho vivo (`SOURCES_RUST=bludv`).
//!
//! O gateway (`adom-server`) abre o streams via `STREAMS_DB` (default
//! `data/streams.db`) e o raw via `CACHE_DB_PATH` (default `data/cache.db`).

mod raw;
mod streams;

pub use raw::{default_raw_quota, is_raw_key, raw_prefix, RawCacheStore};
pub use streams::{
    default_streams_quota, is_streams_key, streams_prefix, StreamsStore, STREAMS_NAMESPACE,
};
