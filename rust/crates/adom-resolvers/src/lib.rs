//! Resolvers BR em Rust — servidor HTTP compatível com Cardigann/Jackett.
//!
//! Cada profile (comandotorrents, torrentdosfilmes, etc.) roda numa porta
//! própria, com o mesmo contrato HTTP do TS: /health, /search, /resolve, /dl, /api.

pub mod callbacks;
pub mod common;
mod flare_fetch;
pub mod flows;
mod items;
pub mod listing_parsers;
pub mod profile;
pub mod search_select;
pub mod server;
mod site_config;
pub mod sites;
