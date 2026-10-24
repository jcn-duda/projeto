//! Página sintética do card Cardigann e feed torznab do Rede Torrent
//! (`createRedeSearchPageHtml` e `rssXml` de `redetorrent-parsers.ts`). O href
//! de cada linha É o magnet do post: sem /resolve e sem download.before. O
//! layout é próprio (não o compacto do núcleo `common::page`).

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_text::{escape_xml, parse_size};

use crate::common::http_date::http_date_now;
use crate::common::{SearchItem, SitePost};

/// Título da release, com o índice do botão quando a página o informa.
pub type TitleFn<'a> = &'a dyn Fn(&SitePost, &ResolverLink, Option<usize>) -> String;

/// `createRedeSearchPageHtml`: cada botão vira uma linha; o `href` do título é o magnet.
pub fn search_page(items: &[SearchItem], title: TitleFn<'_>) -> String {
    let rows: String = items
        .iter()
        .map(|item| {
            let (post, link) = (&item.post, &item.link);
            let size = link
                .size
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("1 KB");
            format!(
                r#"<div class="release"><div class="title"><a href="{}">{}</a></div><div class="size">{}</div><div class="post"><a href="{}">{}</a></div><div class="description">{}</div><div class="seeders">1</div></div>"#,
                escape_xml(&link.url),
                escape_xml(&title(post, link, Some(item.index))),
                escape_xml(size),
                escape_xml(&post.url),
                escape_xml(&post.url),
                escape_xml(&post.title),
            )
        })
        .collect();
    format!(r#"<!doctype html><html><body><div class="posts">{rows}</div></body></html>"#)
}

/// `rssXml`: feed torznab. O título da release sai SEM índice (o TS não passa
/// `index`, então não há "opção N"). Sem data no post, usa o relógio
/// (`br_core::http_date::http_date_now`, o `new Date().toUTCString()` do TS).
pub fn rss_feed(items: &[SearchItem], category: u32, title: TitleFn<'_>) -> String {
    let body: String = items
        .iter()
        .map(|item| {
            let (post, link) = (&item.post, &item.link);
            let size = link.size.as_deref().and_then(parse_size).unwrap_or(0);
            let date = post
                .date
                .as_deref()
                .filter(|d| !d.is_empty())
                .map_or_else(http_date_now, str::to_string);
            format!(
                r#"<item><title>{}</title><guid isPermaLink="false">{}</guid><link>{}</link><comments>{}</comments><pubDate>{}</pubDate><size>{size}</size><category>{category}</category><torznab:attr name="category" value="{category}"/><torznab:attr name="size" value="{size}"/><torznab:attr name="seeders" value="1"/><torznab:attr name="peers" value="1"/><torznab:attr name="downloadvolumefactor" value="0"/><torznab:attr name="uploadvolumefactor" value="1"/></item>"#,
                escape_xml(&title(post, link, None)),
                escape_xml(&link.url),
                escape_xml(&link.url),
                escape_xml(&post.url),
                escape_xml(&date),
            )
        })
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Rede Torrent</title>{body}</channel></rss>"#
    )
}
