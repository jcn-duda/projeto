//! Parsers de sitemap genérico + opções por site (parseSitemapEntries, parseSitemapIndexLocs, etc).
//!
//! Porte direto das regras de descoberta por sitemap do TypeScript:
//! - `sitemap-guard.ts` (`isXmlSitemapShape`, `isVacaSitemapShape`, `assertSitemapScope`, `sitemapFailureMessage`)
//! - `vaca-sitemap-viewer.ts` (`parseViewerEntries`)
//! - Adaptadores de site (`bludv-discovery.ts`, `nerdfilmes-discovery.ts`, `comandotorrents-discovery.ts`,
//!   `torrentdosfilmes-discovery.ts`, `redetorrent-discovery.ts`, `vaca.ts`).

pub mod imdb_parsers;
pub mod shape_guards;
pub mod site_config;
pub mod types;
pub mod viewer_parsers;
pub mod xml_parsers;

// Re-export all public items
pub use imdb_parsers::{
    is_imdb_widget_reference, parse_bludv_imdb_id, parse_imdb_id, parse_vaca_imdb_id,
};
pub use shape_guards::{
    assert_sitemap_scope, is_vaca_sitemap_shape, is_xml_sitemap_shape, sitemap_failure_message,
    sitemap_shape, strip_html_comments, without_html_comments,
};
pub use site_config::{
    is_season_slug, is_work_path, kind_from_slug, kind_from_slug_with_patterns, to_work_url,
    to_work_url_with_options, SitemapSiteConfig,
};
pub use types::{
    CrawlPageKind, SitemapEntry, SitemapParseOptions, SitemapScopeError, SitemapShape,
};
pub use viewer_parsers::{
    parse_redetorrent_viewer_entries, parse_rendered_lastmod, parse_viewer_entries,
};
pub use xml_parsers::{
    parse_sitemap_entries, parse_sitemap_entries_with_options, parse_sitemap_index_locs,
    parse_sitemap_index_locs_matching, parse_sitemap_rows,
};

// Tests
#[cfg(test)]
#[path = "../sitemap_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "../sitemap_tests_fixtures.rs"]
mod tests_fixtures;
