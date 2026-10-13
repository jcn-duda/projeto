//! Saída por site: botões do post, título da release, página do Cardigann e
//! feed torznab. Um arquivo por profile TS (`resolvers/profiles/<site>*.ts`),
//! todos em cima do núcleo `crate::common`. A paridade de cada site é travada
//! por um golden gerado do TS (`scripts/rust/resolver-golden/<site>.mjs` →
//! `tests/golden/<site>.json` → `tests/<site>_golden.rs`).

use adom_crawl::profile_parsers::ResolverLink;

use crate::common::{SearchItem, SitePost};

pub mod comandotorrents;

/// O que cada site entrega para a busca e o feed.
pub trait SiteOutput: Send + Sync {
    /// `parseDownloadLinks(html, postUrl)` do profile. `Err` é o `throw` que o
    /// TS deixa subir (o post inteiro falha).
    fn post_links(&self, html: &str, post_url: &str) -> Result<Vec<ResolverLink>, String>;
    /// `releaseTitle(post, link, index)`.
    fn release_title(&self, post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String;
    /// `searchPageHtml(items)` com o `selfUrl` do resolver.
    fn search_page_html(&self, self_url: &str, items: &[SearchItem]) -> String;
    /// `rssXml(items, category)` quando o profile tem feed torznab próprio.
    fn rss_xml(&self, _self_url: &str, _items: &[SearchItem], _category: u32) -> Option<String> {
        None
    }
}

/// Saída do site pelo nome do resolver (`comandotorrents`, `bludv`, ...).
pub fn site_output(name: &str) -> Option<&'static dyn SiteOutput> {
    match name {
        "comandotorrents" => Some(&comandotorrents::COMANDO),
        _ => None,
    }
}

/// `hasAllowedHost`: o host é o sufixo ou subdomínio dele.
pub fn host_matches(hostname: &str, suffixes: &[&str]) -> bool {
    let host = hostname.to_lowercase();
    suffixes
        .iter()
        .any(|s| host == *s || host.ends_with(&format!(".{s}")))
}
