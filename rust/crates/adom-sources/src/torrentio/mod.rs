//! Cliente do pool público Torrentio (Fase B — par com Prowlarr).
//!
//! Espelha `src/providers/torrentio.ts` / AGENTS.md:
//!
//! - fail-open → `[]`; breaker local (só 429/5xx/rede/timeout);
//! - URL pública sem credencial (`realdebrid=` / apiKey proibidos);
//! - `fileIdx` preservado (truncado se finito); dedupe por hash;
//! - fora dos defaults de instalação (`default_on = false`);
//! - base configurável sob guarda SSRF.
//!
//! Fora desta fatia: integração no orquestrador/`collectRaw`.

mod breaker;
mod client;
mod config;
mod parse;
mod types;

pub use breaker::{now_ms as breaker_now_ms, Breaker};
pub use client::{endpoint_url, TorrentioClient};
pub use config::{TorrentioConfig, TORRENTIO_DEFAULT_TIMEOUT_MS, TORRENTIO_DEFAULT_URL};
pub use parse::{map_stream, parse_metadata, ParsedMetadata};
pub use types::{TorrentioMediaType, TorrentioRawItem, TorrentioSearchArgs};
