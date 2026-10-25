//! Descoberta nativa do raspador (fase 6, trilha de SITEMAP).
//!
//! O motor de crawl consome esta costura: `SiteDiscovery` devolve o que a
//! rodada achou (URLs + completude POR KIND + custo real), e é o motor que
//! grava a fila (`enqueue_discovered`, nunca `upsert_urls`) e move o cursor
//! durável. Nada aqui agenda, grava banco ou lê ambiente.
//!
//! As três camadas, de baixo para cima:
//!
//! - [`rules`] — puro: fase/corte por kind, `maxLastmod`, `Date.parse` do
//!   subconjunto ISO que os sitemaps publicam;
//! - [`service`] — a rodada (índice → sitemaps de obra → relatório), com a
//!   política de falha parcial que impede o cursor de andar sobre acervo não
//!   lido;
//! - [`config`] — a tabela fechada de sites e a diferença de cada um.
//!
//! A trilha de LISTAGEM paginada (HDR/Apache, cursor `lc1`) não está aqui: é a
//! outra metade da fase 6 e entra depois, sobre a mesma costura.

pub mod config;
pub mod fetch;
pub mod rules;
pub mod service;
pub mod types;

use std::future::Future;
use std::pin::Pin;

pub use config::{
    discoverable_sites, discovery_config, EntryShape, KindModel, SitemapDiscoveryConfig,
};
pub use fetch::{SitemapFetch, ACCEPT_SITEMAP};
pub use rules::{
    cursor_key, discovery_cuts, max_lastmod, next_cursor, parse_iso_ms, should_keep, DiscoveryCuts,
    DiscoveryPhase, CURSOR_MOVIE_KEY, CURSOR_TV_KEY, LEGACY_CURSOR_KEY,
};
pub use service::SitemapDiscovery;
pub use types::{DiscoveredUrl, DiscoveryOptions, DiscoveryReport};

/// Futuro de UMA rodada de descoberta.
pub type DiscoveryFuture<'a> =
    Pin<Box<dyn Future<Output = Result<DiscoveryReport, String>> + Send + 'a>>;

/// Quem descobre URLs de um site para o motor.
///
/// `is_ready` existe pelo mesmo motivo do `PageEngine`: sem fonte montada o
/// tick não pode gastar o relógio da descoberta nem o teto por hora.
pub trait SiteDiscovery: Send + Sync {
    fn is_ready(&self) -> bool {
        true
    }

    /// UMA rodada do site. `Err` = nenhuma fonte utilizável (o motor agenda
    /// retry curto); falha PARCIAL viaja dentro do relatório.
    fn discover<'a>(&'a self, site: &'a str, opts: &'a DiscoveryOptions) -> DiscoveryFuture<'a>;
}

impl SiteDiscovery for SitemapDiscovery {
    fn discover<'a>(&'a self, site: &'a str, opts: &'a DiscoveryOptions) -> DiscoveryFuture<'a> {
        Box::pin(async move { SitemapDiscovery::discover(self, site, opts).await })
    }
}

#[cfg(test)]
#[path = "../discovery_service_tests.rs"]
mod service_tests;
#[cfg(test)]
#[path = "../discovery_tests.rs"]
mod tests;
