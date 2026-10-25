//! Quais sites descobrem por LISTAGEM paginada e a diferença de cada um.
//!
//! A tabela é fechada de propósito, como a do sitemap: site sem entrada aqui
//! não descobre por listagem. Hoje são os dois catálogos PHP que NÃO publicam
//! sitemap de obra:
//!
//! | site                      | parser            | caminho das páginas 2+ |
//! |---------------------------|-------------------|------------------------|
//! | `hdrtorrent-cardigann`    | `media-card-link` | `/pagina/N/`           |
//! | `apachetorrent-cardigann` | `div.capa-item`   | `/pagina/N/`           |
//!
//! Fora daqui, de propósito: os seis sites de sitemap (`discovery::config`),
//! `torrentgalaxy-cardigann` (perfil de rede do resolver, não site do raspador)
//! e `mico` (lane `own_pace`, API própria).
//!
//! `cards_per_page` é MEDIDO no site e é a régua do fim do acervo: página com
//! menos cards BRUTOS que isto é a página calcanhar. Contar só os cards aceitos
//! fez o Apache "terminar" a carga na página 211 de 2123 (2026-10-01).

use std::sync::OnceLock;

/// Como os cards da página são lidos (parser e contagem bruta).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListingFlavor {
    /// HDRTorrents: `a.media-card-link`, tipo no `badge-tipo` + slug.
    Hdr,
    /// ApacheTorrents: `div.capa-item`, tipo pelo `item-lead` + slug.
    Apache,
}

/// Configuração de descoberta por listagem de UM site.
#[derive(Debug, Clone, Copy)]
pub struct ListingDiscoveryConfig {
    /// Id do site na fila (`crawl_url.site`), não o `site_id` do parser.
    pub site_id: &'static str,
    pub flavor: ListingFlavor,
    /// Caminho das páginas 2+ (`/pagina/N/`). A página 1 é a raiz do site.
    pub page_path: &'static str,
    /// Cards de uma página CHEIA (medido no site).
    pub cards_per_page: usize,
}

static SITE_TABLE: OnceLock<Vec<ListingDiscoveryConfig>> = OnceLock::new();

fn build_table() -> Vec<ListingDiscoveryConfig> {
    vec![
        ListingDiscoveryConfig {
            site_id: "hdrtorrent-cardigann",
            flavor: ListingFlavor::Hdr,
            page_path: "/pagina/",
            cards_per_page: 20,
        },
        ListingDiscoveryConfig {
            site_id: "apachetorrent-cardigann",
            flavor: ListingFlavor::Apache,
            page_path: "/pagina/",
            cards_per_page: 20,
        },
    ]
}

/// Config de descoberta por listagem do site, ou `None` quando ele não usa
/// esta trilha.
pub fn listing_config(site_id: &str) -> Option<&'static ListingDiscoveryConfig> {
    SITE_TABLE
        .get_or_init(build_table)
        .iter()
        .find(|c| c.site_id == site_id)
}

/// Ids com descoberta por listagem, na ordem da tabela.
pub fn listing_sites() -> Vec<&'static str> {
    SITE_TABLE
        .get_or_init(build_table)
        .iter()
        .map(|c| c.site_id)
        .collect()
}
