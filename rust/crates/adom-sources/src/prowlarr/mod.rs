//! Cliente Prowlarr `/api/v1/search` (Fase B — par com Torrentio).
//!
//! Espelha `src/providers/prowlarr.ts`:
//!
//! - GET `{url}/api/v1/search?apikey=&query=` + header `X-Api-Key`;
//! - sem chave / query vazia / falha de rede → `[]` (fail-open, sem panic);
//! - base configurável sob guarda SSRF (loopback/privado permitido por
//!   default — serviço do operador);
//! - API key nunca em log nem em `Debug`.
//!
//! Fora desta fatia: integração no orquestrador/`collectRaw`.

mod client;
mod config;
mod types;

pub use client::ProwlarrClient;
pub use config::{
    ProwlarrConfig, PROWLARR_DEFAULT_TIMEOUT_MS, PROWLARR_DEFAULT_URL, PROWLARR_USER_AGENT,
};
pub use types::ProwlarrRawItem;
