//! Cliente do addon público Mico Leão Dublado (C4 — busca por IMDb).
//!
//! Espelha `src/providers/mico.ts` / AGENTS.md:
//!
//! - card virtual (`indexer: "mico"`), consultado por IMDb — não passa pelo
//!   Jackett; `mico_net` do crawl (catálogo) NÃO entra aqui;
//! - fail-open → `[]`; breaker local (só 429/5xx/rede/timeout);
//! - 4xx ≠ 429 neutro; HTTP 200 reseta o circuito;
//! - dedupe por `infoHash`; magnet sem `dn=` e trackers na ordem do Node;
//! - base configurável sob guarda SSRF;
//! - `search_outcome` distingue `pending` no prazo do coletor (o Node também
//!   o teria) de falha do host.
//!
//! Fora desta fatia: `mico_net` do crawl (catálogo — usa `fetch_streams`),
//! captura no magnet-bank, pintura de card (`indexerStatus`) e métricas. No
//! coletor nativo não há captura/card/status; o breaker só existe no caminho
//! vivo.

mod breaker;
mod client;
mod config;
mod parse;
mod pictographic;
mod retry_after;
mod types;

pub use breaker::{now_ms as breaker_now_ms, Breaker};
pub use client::{
    endpoint_url, fetch_streams, mico_episode_stream_url, mico_movie_stream_url, MicoClient,
    MicoHttpError,
};
pub use config::{MicoConfig, MICO_DEFAULT_TIMEOUT_MS, MICO_DEFAULT_URL, MICO_ID};
pub use parse::{clean_title, magnet_of, map_stream};
pub use retry_after::retry_after_ms;
pub use types::{
    MicoFetchOutcome, MicoMediaType, MicoOutcome, MicoRawItem, MicoSearchArgs, MicoSearchOptions,
};
