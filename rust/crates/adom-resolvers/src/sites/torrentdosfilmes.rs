//! Tdf (`resolvers/profiles/torrentdosfilmes.ts + torrentdosfilmes-parsers.ts`). ESQUELETO: a saída ainda não foi portada; o golden
//! `tests/torrentdosfilmes_golden.rs` ainda não existe.

use adom_crawl::profile_parsers::ResolverLink;

use super::SiteOutput;
use crate::common::{SearchItem, SitePost};

pub struct Tdf;

pub static TDF: Tdf = Tdf;

impl SiteOutput for Tdf {
    fn post_links(&self, _html: &str, _post_url: &str) -> Result<Vec<ResolverLink>, String> {
        Err("torrentdosfilmes: saída ainda não portada para o Rust".to_string())
    }

    fn release_title(&self, post: &SitePost, _link: &ResolverLink, _index: Option<usize>) -> String {
        post.title.clone()
    }

    fn search_page_html(&self, _self_url: &str, _items: &[SearchItem]) -> String {
        String::new()
    }
}
