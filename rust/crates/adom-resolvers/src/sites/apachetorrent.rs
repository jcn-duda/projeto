//! Apache Torrent (`resolvers/profiles/apachetorrent.ts`): saída da busca. Os
//! botões são magnets DIRETOS no HTML do post (sem `/resolve`): a página
//! sintética e o feed torznab levam o magnet no próprio href. Os parsers ficam em
//! `apachetorrent_parse.rs`; aqui, título, página e feed.
//!
//! O feed carimba `new Date().toUTCString()` em cada item (como o TS). Para o
//! golden ser reprodutível, `feed_with_date` recebe a data por parâmetro; o
//! `rss_xml` do trait usa o relógio real.

#[path = "apachetorrent_parse.rs"]
mod parse;

use std::time::{SystemTime, UNIX_EPOCH};

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_text::escape_xml;

pub use parse::{extract_search_token, parse_search_posts};

use super::SiteOutput;
use crate::common::page::UNKNOWN_SIZE;
use crate::common::{clean_post_title, release_title, ReleaseTitleConfig, SearchItem, SitePost};

pub struct Apache;

pub static APACHE: Apache = Apache;

/// `releaseTitle` do Apache: sem tamanho (o site não publica) e com a tag de
/// áudio do magnet, que desempata as opções do mesmo post no card.
const TITLE: ReleaseTitleConfig = ReleaseTitleConfig {
    audio_tag_of: Some(audio_tag),
    with_size: false,
    ..ReleaseTitleConfig::new(clean_post_title)
};

fn audio_tag(link: &ResolverLink) -> Option<String> {
    let tag = match link.audio.as_deref() {
        Some("dublado") => "DUBLADO",
        Some("dual") => "DUAL",
        Some("legendado") => "LEGENDADO",
        _ => return None,
    };
    Some(tag.to_string())
}

/// Uma linha da página sintética. O post tem elemento próprio (`div.post > a`)
/// para o details ler a URL; a descrição cai no título do post sem descrição.
fn page_row(item: &SearchItem) -> String {
    let title = escape_xml(&release_title(
        &TITLE,
        &item.post,
        &item.link,
        Some(item.index),
    ));
    let size = item
        .link
        .size
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(UNKNOWN_SIZE);
    let post_url = escape_xml(&item.post.url);
    let description = item
        .link
        .description
        .as_deref()
        .filter(|d| !d.is_empty())
        .unwrap_or(item.post.title.as_str());
    format!(
        r#"<div class="release"><div class="title"><a href="{}">{title}</a></div><div class="size">{}</div><div class="post"><a href="{post_url}">{post_url}</a></div><div class="description">{}</div><div class="seeders">1</div></div>"#,
        escape_xml(&item.link.url),
        escape_xml(size),
        escape_xml(description),
    )
}

/// Feed torznab do Apache com a data de publicação injetada (ver o módulo).
pub fn feed_with_date(items: &[SearchItem], category: u32, pub_date: &str) -> String {
    let body: String = items
        .iter()
        .map(|item| {
            let title = escape_xml(&release_title(
                &TITLE,
                &item.post,
                &item.link,
                Some(item.index),
            ));
            let link = escape_xml(&item.link.url);
            let comments = escape_xml(&item.post.url);
            format!(
                r#"<item><title>{title}</title><guid isPermaLink="false">{link}</guid><link>{link}</link><comments>{comments}</comments><pubDate>{pub_date}</pubDate><size>0</size><category>{category}</category><torznab:attr name="category" value="{category}"/><torznab:attr name="size" value="0"/><torznab:attr name="seeders" value="1"/><torznab:attr name="peers" value="1"/><torznab:attr name="downloadvolumefactor" value="0"/><torznab:attr name="uploadvolumefactor" value="1"/></item>"#
            )
        })
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>Apache Torrent</title>{body}</channel></rss>"#
    )
}

const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `Date.prototype.toUTCString()` de um instante em segundos desde a época:
/// "Tue, 13 Oct 2026 12:00:00 GMT". Civil-from-days sem dependência de data.
pub fn utc_date(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let secs = epoch_secs.rem_euclid(86_400);
    // 1970-01-01 foi quinta-feira: índice 4 em WEEKDAYS.
    let weekday = WEEKDAYS[(days + 4).rem_euclid(7) as usize];
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let month_name = MONTHS[(month - 1) as usize];
    format!(
        "{weekday}, {day:02} {month_name} {year} {:02}:{:02}:{:02} GMT",
        secs / 3_600,
        secs % 3_600 / 60,
        secs % 60
    )
}

fn utc_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(0));
    utc_date(secs)
}

impl SiteOutput for Apache {
    fn post_links(&self, html: &str, post_url: &str) -> Result<Vec<ResolverLink>, String> {
        Ok(parse::parse_post_magnets(html, post_url))
    }

    fn release_title(&self, post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String {
        release_title(&TITLE, post, link, index)
    }

    fn search_page_html(&self, _self_url: &str, items: &[SearchItem]) -> String {
        let rows: String = items.iter().map(page_row).collect();
        format!(r#"<!doctype html><html><body><div class="posts">{rows}</div></body></html>"#)
    }

    fn rss_xml(&self, _self_url: &str, items: &[SearchItem], category: u32) -> Option<String> {
        Some(feed_with_date(items, category, &utc_now()))
    }
}
