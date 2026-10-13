//! Cliente HTTP do Mico Leão Dublado: throttle, busca de catálogo e tipos.
//!
//! Módulo auto-contido que porta a lógica de rede do raspador do Mico
//! (`src/providers/crawl-sites/mico-shared.ts`) para Rust.
//!
//! # Componentes
//!
//! - [`MicoThrottle`]: serialização de chamadas com gap mínimo + Retry-After.
//! - [`MicoClient`]: cliente HTTP com throttle integrado.
//! - [`CatalogPage`], [`CatalogType`], [`MicoError`], [`MicoClientConfig`]: tipos.
//! - [`parse_retry_after`]: extrai `Retry-After` dos headers HTTP.

pub mod client;
pub mod throttle;
pub mod types;

#[cfg(test)]
mod tests;

pub use client::{parse_retry_after, MicoClient};
pub use throttle::MicoThrottle;
pub use types::{CatalogPage, CatalogType, MicoClientConfig, MicoError};
