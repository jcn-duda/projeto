//! Cliente do addon público Mico Leão Dublado (Fase B — busca por IMDb).
//!
//! Espelha `src/providers/mico.ts` / AGENTS.md:
//!
//! - card virtual (`indexer: "mico"`), consultado por IMDb — não passa pelo
//!   Jackett; `mico_net` do crawl (catálogo) NÃO entra aqui;
//! - fail-open → `[]`; breaker local (só 429/5xx/rede/timeout);
//! - 4xx ≠ 429 neutro; HTTP 200 reseta o circuito;
//! - dedupe por `infoHash`; magnet sem `dn=`;
//! - base configurável sob guarda SSRF.
//!
//! Fora desta fatia: integração no orquestrador/`collectRaw`, magnet-bank,
//! pintura de card (`indexerStatus`) e métricas.

mod breaker;
mod client;
mod config;
mod parse;
mod types;

pub use breaker::{now_ms as breaker_now_ms, Breaker};
pub use client::{
    endpoint_url, fetch_streams, mico_episode_stream_url, mico_movie_stream_url, MicoClient,
    MicoHttpError,
};
pub use config::{MicoConfig, MICO_DEFAULT_TIMEOUT_MS, MICO_DEFAULT_URL, MICO_ID};
pub use parse::{clean_title, magnet_of, map_stream, retry_after_ms};
pub use types::{MicoFetchOutcome, MicoMediaType, MicoRawItem, MicoSearchArgs};
