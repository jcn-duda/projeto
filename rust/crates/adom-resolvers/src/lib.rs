//! Resolvers BR em Rust — servidor HTTP compatível com Cardigann/Jackett.
//!
//! Cada profile (comandotorrents, torrentdosfilmes, etc.) roda numa porta
//! própria, com o mesmo contrato HTTP do TS: /health, /search, /resolve, /dl, /api.

pub mod profile;
pub mod server;
