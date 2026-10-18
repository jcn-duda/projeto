//! Cliente do scraper BLUDV (Fase B — busca por título WordPress).
//!
//! Espelha `src/providers/bludv.ts` no essencial:
//!
//! - `GET {base}/?s=` → posts → links legado → protetor → magnet;
//! - falha de rede → `[]` sem panic;
//! - gate de anúncio detectado e pulado no caminho de busca (solve longo
//!   nunca entra na resposta; cache/prefetch de gate fica para fatia futura);
//! - `is_br: true`, `seeders: 1`, `tracker: "BLUDV"`.
//!
//! Não reusa o binário `adom-resolvers` via HTTP nesta fatia (cliente fino
//! próprio). Parsing de posts/links é local; o resolvedor Jackett Cardigann
//! continua separado.
//!
//! Fora desta fatia: cache `raw:v1`, prefetch/coalescing do gate, integração
//! no `collectRaw`.

mod client;
mod config;
mod parse;
mod types;

pub use client::BludvClient;
pub use config::{BludvConfig, BLUDV_DEFAULT_TIMEOUT_MS, BLUDV_DEFAULT_URL, BLUDV_USER_AGENT};
pub use parse::{
    extract_magnet, is_gate_url, is_valid_magnet_uri, parse_download_links, parse_posts, parse_size,
    release_title,
};
pub use types::{BludvDownloadLink, BludvPost, BludvRawItem, BludvSearchOpts};
