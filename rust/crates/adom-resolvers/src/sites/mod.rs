//! Saída por site: botões do post, título da release, página do Cardigann e
//! feed torznab. Um arquivo por profile TS (`resolvers/profiles/<site>*.ts`),
//! todos em cima do núcleo `crate::common`. A paridade de cada site é travada
//! por um golden gerado do TS (`scripts/rust/resolver-golden/<site>.mjs` →
//! `tests/golden/<site>.json` → `tests/<site>_golden.rs`).

use adom_crawl::profile_parsers::ResolverLink;

use crate::common::{SearchItem, SitePost};

pub mod apachetorrent;
pub mod bludv;
pub mod comandotorrents;
pub mod hdrtorrents;
pub mod nerdfilmes;
pub mod redetorrent;
pub mod torrentdosfilmes;
pub mod vacatorrent;

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

    // ── Fluxo da busca (`searchPosts` do profile). Defaults = ComandoTorrents.

    /// Posts da página de busca (`parsePosts`/`parseSearchHtml`).
    fn search_posts(&self, html: &str, base_url: &str) -> Vec<SitePost> {
        crate::listing_parsers::parse_listing_posts(self.name(), html, base_url)
            .into_iter()
            .map(|p| SitePost {
                title: p.title,
                url: p.url,
                poster: p.poster,
                ..Default::default()
            })
            .collect()
    }

    /// `selectSearchPosts`: título, temporada e corte em `max_posts`.
    fn select_posts(
        &self,
        posts: Vec<SitePost>,
        normalized: &str,
        season: Option<u32>,
        max_posts: usize,
    ) -> Vec<SitePost> {
        crate::search_select::select_posts(
            posts,
            |p| p.title.as_str(),
            normalized,
            season,
            max_posts,
        )
    }

    /// `postToItems`: um item por botão (índice e total sobre a lista do post).
    fn items_of(
        &self,
        post: &SitePost,
        links: Vec<ResolverLink>,
        _season: Option<u32>,
    ) -> Vec<SearchItem> {
        let count = links.len();
        links
            .into_iter()
            .enumerate()
            .map(|(index, link)| SearchItem {
                post: post.clone(),
                link,
                index,
                count,
            })
            .collect()
    }

    /// `true` quando o profile engole a falha de um post (`try` no `mapLimit`:
    /// rede/apache/hdr/vaca); `false` deixa o erro derrubar a busca (comando,
    /// bludv, tdf).
    fn post_error_is_empty(&self) -> bool {
        false
    }

    /// Metadado do post lido da PRÓPRIA página do post (o nerd põe a data
    /// dela na linha da busca).
    fn post_date(&self, _html: &str) -> Option<String> {
        None
    }

    /// Nome do resolver (o mesmo de `site_output`).
    fn name(&self) -> &'static str;
}

/// Saída do site pelo nome do resolver (`comandotorrents`, `bludv`, ...).
pub fn site_output(name: &str) -> Option<&'static dyn SiteOutput> {
    match name {
        "comandotorrents" => Some(&comandotorrents::COMANDO),
        "bludv" => Some(&bludv::BLUDV),
        "nerdfilmes" => Some(&nerdfilmes::NERD),
        "torrentdosfilmes" => Some(&torrentdosfilmes::TDF),
        "vacatorrent" => Some(&vacatorrent::VACA),
        "redetorrent" => Some(&redetorrent::REDE),
        "apachetorrent" => Some(&apachetorrent::APACHE),
        "hdrtorrents" => Some(&hdrtorrents::HDR),
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
