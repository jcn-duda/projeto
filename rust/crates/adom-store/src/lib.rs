//! Store SQLite do namespace `streams:v21` — embrião da Fase D.
//!
//! Espelha o padrão de `adom-debrid::store` (rusqlite, WAL, tabela `cache`,
//! cota por prefixo com despejo do que expira primeiro), mas a semântica de
//! leitura é a do SWR em `adom-search::cache`: `get` é duro; `get_with_stale`
//! serve dentro da graça sem apagar.
//!
//! Nesta fatia: **só** `streams:v21`. Sem import do `cache.db`, sem magnets,
//! sem plugar no gateway/Orchestrator.

mod streams;

pub use streams::{
    default_streams_quota, is_streams_key, streams_prefix, StreamsStore, STREAMS_NAMESPACE,
};
