//! Página sintética do card Cardigann e feed torznab do Rede Torrent
//! (`createRedeSearchPageHtml` e `rssXml` de `redetorrent-parsers.ts`). O href
//! de cada linha É o magnet do post: sem /resolve e sem download.before. O
//! layout é próprio (não o compacto do núcleo `common::page`).

use std::time::{SystemTime, UNIX_EPOCH};

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_text::{escape_xml, parse_size};

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
/// `index`, então não há "opção N"). Sem data no post, usa o relógio.
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

/// `new Date().toUTCString()`: "Tue, 13 Oct 2026 17:00:00 GMT" (dia com dois dígitos).
pub fn http_date_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let days = secs.div_euclid(86_400);
    let (hour, minute, second) = (
        secs.rem_euclid(86_400) / 3_600,
        secs.rem_euclid(3_600) / 60,
        secs.rem_euclid(60),
    );
    // 1970-01-01 foi quinta-feira (índice 4 com domingo = 0).
    let weekday =
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][(days + 4).rem_euclid(7) as usize];
    // Data civil a partir de dias desde 1970 (algoritmo de Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let month_name = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ][(month - 1) as usize];
    format!("{weekday}, {day:02} {month_name} {year} {hour:02}:{minute:02}:{second:02} GMT")
}
