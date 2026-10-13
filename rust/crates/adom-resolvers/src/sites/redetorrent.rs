//! Rede (`resolvers/profiles/redetorrent.ts + redetorrent-parsers.ts`). Os
//! magnets vêm DIRETOS no HTML do post: não há protetor nem /resolve. Parsers
//! em `redetorrent_parse.rs`, magnet em `redetorrent_magnet.rs`, página e feed
//! em `redetorrent_feed.rs`. Paridade travada por `tests/redetorrent_golden.rs`.

use std::sync::LazyLock;

use crate::common::text::decode_entities;
use adom_crawl::profile_parsers::ResolverLink;
use regex::Regex;

use super::SiteOutput;
use crate::common::{release_title, ReleaseTitleConfig, SearchItem, SitePost};

#[path = "redetorrent_feed.rs"]
mod feed;
#[path = "redetorrent_magnet.rs"]
mod magnet;
#[path = "redetorrent_parse.rs"]
mod parse;

pub use parse::parse_search_posts;

pub struct Rede;

pub static REDE: Rede = Rede;

static TORRENT_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*Torrents?\s*(?:Download)?\s*").expect("palavra Torrent do título")
});
static FILM_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*(?:Filme|S[ée]rie|Baixar|Download)\s+").expect("prefixo do tema")
});
static SITE_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s*[-–|]\s*Rede Torrent\s*$").expect("sufixo do site"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("espaços"));

/// `cleanPostTitle` do Rede: decodifica entidades, tira "Torrent", o prefixo
/// "Filme/Série/Baixar/Download" do tema e o sufixo " - Rede Torrent".
pub fn clean_title(title: &str) -> String {
    let mut clean = decode_entities(title);
    clean = TORRENT_WORD.replace_all(&clean, " ").into_owned();
    clean = FILM_PREFIX.replace(&clean, "").into_owned();
    clean = SITE_SUFFIX.replace(&clean, "").into_owned();
    SPACES.replace_all(&clean, " ").trim().to_string()
}

/// `titleOf`: o título real do botão quando existe; senão o do post.
fn title_of(post: &SitePost, link: &ResolverLink) -> String {
    link.real_title
        .as_deref()
        .filter(|t| !t.is_empty())
        .unwrap_or(&post.title)
        .to_string()
}

/// `audioTagOf`: só dublado, dual e legendado ganham tag; o resto não tem.
fn audio_tag(link: &ResolverLink) -> Option<String> {
    let tag = match link.audio.as_deref() {
        Some("dublado") => "DUBLADO",
        Some("dual") => "DUAL",
        Some("legendado") => "LEGENDADO",
        _ => return None,
    };
    Some(tag.to_string())
}

/// `seasonOf`: "S01" quando o botão tem temporada e não tem título real próprio.
fn season_tag(_post: &SitePost, link: &ResolverLink) -> String {
    if link.real_title.as_deref().is_some_and(|t| !t.is_empty()) {
        return String::new();
    }
    link.season.map_or_else(String::new, |s| format!("S{s:02}"))
}

const TITLE: ReleaseTitleConfig = ReleaseTitleConfig {
    title_of: Some(title_of),
    audio_tag_of: Some(audio_tag),
    season_of: Some(season_tag),
    ..ReleaseTitleConfig::new(clean_title)
};

impl SiteOutput for Rede {
    fn name(&self) -> &'static str {
        "redetorrent"
    }

    /// `parseSearchHtml` + `workTypeFromPath` (`/filmes/` × `/series/`).
    fn search_posts(&self, html: &str, base_url: &str) -> Vec<SitePost> {
        parse_search_posts(html, base_url)
            .into_iter()
            .map(|mut post| {
                let path = url::Url::parse(&post.url)
                    .map(|u| u.path().to_string())
                    .unwrap_or_default();
                post.kind = if path.starts_with("/filmes/") {
                    Some("Filme".into())
                } else if path.starts_with("/series/") {
                    Some("Série".into())
                } else {
                    None
                };
                post
            })
            .collect()
    }

    /// Com temporada pedida, série vem antes de filme (ANTES do corte).
    fn select_posts(
        &self,
        posts: Vec<SitePost>,
        normalized: &str,
        season: Option<u32>,
        max_posts: usize,
    ) -> Vec<SitePost> {
        let mut posts = crate::search_select::select_posts(
            posts,
            |p| p.title.as_str(),
            normalized,
            season,
            usize::MAX,
        );
        if season.is_some() {
            let (series, rest): (Vec<_>, Vec<_>) = posts
                .into_iter()
                .partition(|p| p.kind.as_deref() == Some("Série"));
            posts = series.into_iter().chain(rest).collect();
        }
        posts.truncate(max_posts);
        posts
    }

    /// `postToItems`: botão de outra temporada sai; o índice conta a lista
    /// FILTRADA e o total é o do post inteiro, como o TS.
    fn items_of(
        &self,
        post: &SitePost,
        links: Vec<ResolverLink>,
        season: Option<u32>,
    ) -> Vec<SearchItem> {
        let count = links.len();
        links
            .into_iter()
            .filter(|l| l.season.is_none() || season.is_none() || l.season == season)
            .enumerate()
            .map(|(index, link)| SearchItem {
                post: post.clone(),
                link,
                index,
                count,
            })
            .collect()
    }

    fn post_error_is_empty(&self) -> bool {
        true
    }

    fn post_links(&self, html: &str, post_url: &str) -> Result<Vec<ResolverLink>, String> {
        Ok(parse::parse_post_links(html, post_url))
    }

    fn release_title(&self, post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String {
        release_title(&TITLE, post, link, index)
    }

    fn search_page_html(&self, _self_url: &str, items: &[SearchItem]) -> String {
        feed::search_page(items, &|post, link, index| {
            release_title(&TITLE, post, link, index)
        })
    }

    fn rss_xml(&self, _self_url: &str, items: &[SearchItem], category: u32) -> Option<String> {
        Some(feed::rss_feed(items, category, &|post, link, index| {
            release_title(&TITLE, post, link, index)
        }))
    }
}
