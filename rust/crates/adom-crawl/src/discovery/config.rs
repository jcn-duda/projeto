//! Quais sites descobrem por sitemap e COMO cada um distribui a completude.
//!
//! A tabela é fechada de propósito: site sem entrada aqui não descobre por
//! sitemap, e o motor não gasta requisição para descobrir isso em tempo de
//! execução. Hoje:
//!
//! | site                  | forma                                  |
//! |-----------------------|----------------------------------------|
//! | `vacatorrent`         | sitemap por KIND (`movie-`/`tv_show-`) |
//! | `redetorrent-cardigann` | sitemap por KIND (`movies-`/`tvshows-`) |
//! | `bludv-cardigann`     | `post-sitemap*` MISTO                  |
//! | `nerdfilmes`          | `post-sitemap*` MISTO                  |
//! | `comandotorrents`     | `post-sitemap*` MISTO                  |
//! | `torrentdosfilmesv2`  | `post-sitemap*` MISTO                  |
//!
//! Fora daqui, de propósito: `hdrtorrent-cardigann` e `apachetorrent-cardigann`
//! (listagem paginada, outra trilha), `torrentgalaxy-cardigann` (perfil de rede
//! do resolver, não site do raspador) e `mico` (lane `own_pace` com descoberta
//! própria, `mico_discovery`).
//!
//! A DIFERENÇA que a `KindModel` carrega é a que muda o cursor: no sitemap por
//! kind, o arquivo de série caído não pode travar o cursor de filme. No
//! `post-sitemap` misto não dá para dizer qual kind o arquivo alimentava, então
//! a falha derruba os dois.

use std::sync::OnceLock;

use crate::sitemap::SitemapSiteConfig;

/// Como a rodada reparte a completude entre os kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KindModel {
    /// `post-sitemap*` MISTO: arquivo ilegível não prova completude de NENHUM
    /// kind. `tv_hidden_off` reproduz a diferença medida entre os sites: no
    /// BLUDV, com as séries fora do gate, a completude de série é trivial
    /// (`true`); nos outros três ela segue a do arquivo.
    Mixed { tv_hidden_off: bool },
    /// Sitemap por KIND: cada arquivo responde por um kind só, e a falha marca
    /// apenas ele. O arquivo de série nem é pedido com as séries desligadas.
    PerKind,
}

/// Que forma de corpo o parser de um sitemap de obra aceita.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryShape {
    /// Só XML de sitemap (`isSitemapXml` do TS).
    Xml,
    /// XML **ou** tabela do visualizador (`sitemapShape` do TS) — Vaca e
    /// RedeTorrent alternam entre os dois formatos a cada sessão do browser.
    XmlOrViewer,
}

/// Configuração de descoberta de UM site.
#[derive(Debug, Clone)]
pub struct SitemapDiscoveryConfig {
    /// Id do site na fila (`crawl_url.site`), não o `site_id` do parser.
    pub site_id: &'static str,
    /// Caminhos de índice, padrão de `post-sitemap`, régua de obra e de slug.
    pub sitemap: SitemapSiteConfig,
    pub kind_model: KindModel,
    pub shape: EntryShape,
    /// Fragmento do caminho que identifica o ARQUIVO de série (`PerKind`).
    /// Vazio nos sites de `post-sitemap` misto.
    pub series_loc_marker: &'static str,
}

impl SitemapDiscoveryConfig {
    /// O `loc` do índice é o arquivo de SÉRIE? (só faz sentido em `PerKind`.)
    pub fn is_series_loc(&self, loc: &str) -> bool {
        !self.series_loc_marker.is_empty() && loc.to_lowercase().contains(self.series_loc_marker)
    }
}

static SITE_TABLE: OnceLock<Vec<SitemapDiscoveryConfig>> = OnceLock::new();

fn build_table() -> Vec<SitemapDiscoveryConfig> {
    vec![
        SitemapDiscoveryConfig {
            site_id: "vacatorrent",
            sitemap: SitemapSiteConfig::vaca(),
            kind_model: KindModel::PerKind,
            shape: EntryShape::XmlOrViewer,
            series_loc_marker: "tv_show-sitemap",
        },
        SitemapDiscoveryConfig {
            site_id: "redetorrent-cardigann",
            sitemap: SitemapSiteConfig::redetorrent(),
            kind_model: KindModel::PerKind,
            shape: EntryShape::XmlOrViewer,
            series_loc_marker: "tvshows-sitemap",
        },
        SitemapDiscoveryConfig {
            site_id: "bludv-cardigann",
            sitemap: SitemapSiteConfig::bludv(),
            // Bludv: `completeByKind.tv_show = emitSeries ? complete : true`.
            kind_model: KindModel::Mixed {
                tv_hidden_off: true,
            },
            shape: EntryShape::Xml,
            series_loc_marker: "",
        },
        SitemapDiscoveryConfig {
            site_id: "nerdfilmes",
            sitemap: SitemapSiteConfig::nerdfilmes(),
            kind_model: KindModel::Mixed {
                tv_hidden_off: false,
            },
            shape: EntryShape::Xml,
            series_loc_marker: "",
        },
        SitemapDiscoveryConfig {
            site_id: "comandotorrents",
            sitemap: SitemapSiteConfig::comandotorrents(),
            kind_model: KindModel::Mixed {
                tv_hidden_off: false,
            },
            shape: EntryShape::Xml,
            series_loc_marker: "",
        },
        SitemapDiscoveryConfig {
            site_id: "torrentdosfilmesv2",
            // O id do parser (`torrentdosfilmes`) não é o id da fila.
            sitemap: SitemapSiteConfig {
                site_id: "torrentdosfilmesv2",
                ..SitemapSiteConfig::torrentdosfilmes()
            },
            kind_model: KindModel::Mixed {
                tv_hidden_off: false,
            },
            shape: EntryShape::Xml,
            series_loc_marker: "",
        },
    ]
}

/// Config de descoberta do site, ou `None` quando ele não descobre por sitemap.
pub fn discovery_config(site_id: &str) -> Option<&'static SitemapDiscoveryConfig> {
    SITE_TABLE
        .get_or_init(build_table)
        .iter()
        .find(|c| c.site_id == site_id)
}

/// Ids com descoberta por sitemap, na ordem da tabela.
pub fn discoverable_sites() -> Vec<&'static str> {
    SITE_TABLE
        .get_or_init(build_table)
        .iter()
        .map(|c| c.site_id)
        .collect()
}
