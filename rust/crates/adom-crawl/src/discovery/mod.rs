//! Descoberta nativa do raspador (fase 6).
//!
//! O motor de crawl consome esta costura: `SiteDiscovery` devolve o que a
//! rodada achou (URLs + completude POR KIND + custo real + estado durável a
//! gravar), e é o motor que grava a fila (`enqueue_discovered`, nunca
//! `upsert_urls`), o cursor durável (só com a fila aceita) e a agenda. Nada
//! aqui agenda ou lê ambiente.
//!
//! Duas TRILHAS, uma costura:
//!
//! - [`config`] + [`service`] — **sitemap** (seis sites com sitemap de obra):
//!   índice → sitemaps → relatório, com a política de falha parcial que impede
//!   o cursor de andar sobre acervo não lido. As regras puras de data/corte
//!   ficam em [`rules`].
//! - [`listing`] — **listagem paginada** (HDR e Apache, cursor `lc1`): janela
//!   deslizante com fim OBSERVADO, estado durável próprio (cursor + marcador de
//!   séries) e o mesmo relatório no fim.
//!
//! [`RoutedDiscovery`] escolhe a trilha pelo site; o motor só conhece uma.

pub mod config;
pub mod fetch;
pub mod listing;
pub mod rules;
pub mod service;
pub mod types;

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub use config::{discovery_config, sitemap_sites, EntryShape, KindModel, SitemapDiscoveryConfig};
pub use fetch::{SitemapFetch, ACCEPT_SITEMAP};
pub use rules::{
    cursor_key, discovery_cuts, max_lastmod, next_cursor, parse_iso_ms, should_keep, DiscoveryCuts,
    DiscoveryPhase, CURSOR_MOVIE_KEY, CURSOR_TV_KEY, LEGACY_CURSOR_KEY,
};
pub use service::SitemapDiscovery;
pub use types::{DiscoveredUrl, DiscoveryOptions, DiscoveryReport};

pub use listing::{
    listing_config, listing_sites, ListingDiscovery, ListingDiscoveryConfig, ListingFlavor,
};

/// Todos os sites que o motor pode descobrir, na ordem das trilhas (sitemap
/// primeiro, listagem depois).
pub fn discoverable_sites() -> Vec<&'static str> {
    let mut sites = sitemap_sites();
    sites.extend(listing_sites());
    sites
}

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

    /// Chaves de `crawl_state` que a rodada do site precisa ler ANTES de rodar
    /// (cursor, marcador de portão). O motor lê estas e entrega os valores em
    /// `DiscoveryOptions::site_state`; a trilha que não tem estado durável
    /// devolve vazio.
    fn state_keys(&self, site: &str) -> Vec<String> {
        let _ = site;
        Vec::new()
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

impl SiteDiscovery for ListingDiscovery {
    fn state_keys(&self, site: &str) -> Vec<String> {
        ListingDiscovery::state_keys(self, site)
    }

    fn discover<'a>(&'a self, site: &'a str, opts: &'a DiscoveryOptions) -> DiscoveryFuture<'a> {
        Box::pin(async move { ListingDiscovery::discover(self, site, opts).await })
    }
}

/// Roteia a rodada do site para a trilha dele: listagem quando há entrada em
/// [`listing_config`], sitemap no resto.
///
/// O motor conhece UMA `SiteDiscovery`; sem este roteador ele teria de
/// perguntar o site a cada rodada (e a trilha acabaria duplicada em dois
/// `with_discovery` que se sobrescrevem).
pub struct RoutedDiscovery {
    sitemap: Arc<SitemapDiscovery>,
    listing: Arc<ListingDiscovery>,
}

impl RoutedDiscovery {
    pub fn new(sitemap: Arc<SitemapDiscovery>, listing: Arc<ListingDiscovery>) -> Self {
        Self { sitemap, listing }
    }
}

impl SiteDiscovery for RoutedDiscovery {
    fn is_ready(&self) -> bool {
        self.sitemap.is_ready() || self.listing.is_ready()
    }

    fn state_keys(&self, site: &str) -> Vec<String> {
        if listing_config(site).is_some() {
            self.listing.state_keys(site)
        } else {
            self.sitemap.state_keys(site)
        }
    }

    fn discover<'a>(&'a self, site: &'a str, opts: &'a DiscoveryOptions) -> DiscoveryFuture<'a> {
        // Qualificação pela TRAIT de propósito: `ListingDiscovery::discover` é
        // `async fn` e devolveria um futuro, não o `DiscoveryFuture` boxed.
        if listing_config(site).is_some() {
            SiteDiscovery::discover(self.listing.as_ref(), site, opts)
        } else {
            SiteDiscovery::discover(self.sitemap.as_ref(), site, opts)
        }
    }
}

#[cfg(test)]
#[path = "../discovery_service_tests.rs"]
mod service_tests;
#[cfg(test)]
#[path = "../discovery_tests.rs"]
mod tests;
