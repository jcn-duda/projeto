//! HDR Torrents (`resolvers/profiles/hdrtorrents.ts` + `hdrtorrents-parsers.ts`).
//!
//! Três pontos que não são o núcleo comum e por isso moram aqui:
//! - o magnet é DIRETO no HTML do post: a página sintética põe o magnet no
//!   `href` da linha, sem `/resolve`;
//! - o áudio é o `classifyAudio` próprio do HDR (DUAL vence DUBLADO), e o
//!   título da release leva DUBLADO/DUAL/LEGENDADO sem tamanho;
//! - entidades e `isValidMagnetUri` seguem `resolvers/text.ts` e
//!   `bludv-parsers.ts`, não as variantes do `adom-core`/`adom-crawl`: a tabela
//!   de nomes é a curta, o `xt` aceita caixa e espaço, e a magnet não é
//!   normalizada (só decodificada).
//!
//! O núcleo do `parseContentMagnets` (regex de `.download-row`, `classifyAudio`,
//! `extractEpisodeFromName`, `dn` do magnet, `extractSizeFromTechSheet`) mora em
//! `br_core::hdr` — compartilhado com o raspador. A listagem (`parseListingHtml`)
//! e a página sintética ficam aqui porque são exclusivas do resolver.
//!
//! Divergências conhecidas e aceitas: `\s` das regex é o Unicode (o JS exclui
//! U+0085 e inclui U+FEFF); entidade numérica de surrogate falha aqui (o JS
//! produz um surrogate solto). Ambas ficam fora do golden.

use std::collections::HashSet;
use std::sync::LazyLock;

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_text::escape_xml;
use regex::Regex;
use url::Url;

use super::SiteOutput;
use crate::common::http_date::{http_date_now, http_date_secs};
use crate::common::{
    clean_post_title, release_title, ReleaseTitleConfig, SearchItem, SitePost, UNKNOWN_SIZE,
};

#[path = "hdrtorrents_text.rs"]
mod text;

use text::{decode_entities_ts, strip_tags_ts};

/// Card da listagem (`HDRWork` do TS).
#[derive(Debug, Clone, PartialEq)]
pub struct HdrWork {
    pub url: String,
    pub title: String,
    pub year: Option<u32>,
    pub poster: Option<String>,
    /// "Filme", "Série" ou "Desenho".
    pub kind: Option<&'static str>,
    pub quality: Option<String>,
}

pub struct Hdr;

pub static HDR: Hdr = Hdr;

// ─── regex da listagem (paridade com o JS) ─────────────────────────────────

static BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<a(?-u:\b)[^>]*?(?-u:\b)href=["']([^"']+)["'][^>]*?(?-u:\b)class=["'][^"']*media-card-link[^"']*["'][^>]*>([\s\S]*?)</a>"#)
        .expect("card da listagem")
});
static CARD_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*media-card-title[^"']*["'][\s\S]*?>([\s\S]*?)$"#)
        .expect("título")
});
/// Fallback sem `$`: o TS tem dois regex para título.
static CARD_TITLE_FALLBACK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*media-card-title[^"']*["'][\s\S]*?>([\s\S]*)"#)
        .expect("título fallback")
});
static CARD_YEAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*media-card-year[^"']*["'][\s\S]*?>\s*\(?([0-9]{4})\)?"#)
        .expect("ano")
});
static CARD_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*badge-tipo[^"']*["'][\s\S]*?>([\s\S]*?)</(?:span|div|a)"#)
        .expect("tipo")
});
static CARD_QUALITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)class=["'][^"']*badge-qualidade[^"']*["'][\s\S]*?>([\s\S]*?)</(?:span|div|a)"#,
    )
    .expect("qualidade")
});
static CARD_POSTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*media-card-cover[^"']*["'][\s\S]*?>\s*<img[\s\S]*?(?-u:\b)(?:data-)?src=["']([^"']+)["']"#)
        .expect("capa")
});
static KIND_SERIE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)s[ée]rie").expect("série"));
static KIND_DESENHO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)desenho|anima").expect("desenho"));
static KIND_FILME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)filme").expect("filme"));

// ─── parsers ──────────────────────────────────────────────────────────────

/// `parseListingHtml(html, baseUrl)`: um card por `.media-card-link`, sem repetir URL.
/// O título do TS é o texto depois do primeiro `>` da tag do título até o fim
/// do bloco, então o ano da `<span>` entra nele (ex.: "Título (2026)").
pub fn parse_listing_html(html: &str, base_url: &str) -> Result<Vec<HdrWork>, String> {
    let base = Url::parse(base_url).ok();
    let root = format!("{base_url}/");
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for caps in BLOCK.captures_iter(html) {
        // Tolerar erro por card: uma entidade inválida não aborta a página inteira.
        let href = match decode_entities_ts(&caps[1]) {
            Ok(h) => h,
            Err(_) => continue,
        };
        let inner = &caps[2];
        if inner.is_empty() {
            continue;
        }
        let Some(resolved) = base
            .as_ref()
            .and_then(|b| b.join(&href).ok())
            .map(String::from)
        else {
            continue;
        };
        if resolved == base_url || resolved == root {
            continue;
        }
        if !seen.insert(resolved.clone()) {
            continue;
        }
        // Título com fallback (paridade com o TS).
        let title = match CARD_TITLE.captures(inner) {
            Some(c) => strip_tags_ts(&c[1]).unwrap_or_default(),
            None => match CARD_TITLE_FALLBACK.captures(inner) {
                Some(c) => strip_tags_ts(&c[1]).unwrap_or_default(),
                None => String::new(),
            },
        };
        if title.is_empty() {
            continue;
        }
        let year = CARD_YEAR
            .captures(inner)
            .and_then(|c| c[1].parse::<u32>().ok());
        let type_text = CARD_TYPE
            .captures(inner)
            .and_then(|c| strip_tags_ts(&c[1]).ok())
            .unwrap_or_default();
        let kind = if KIND_SERIE.is_match(&type_text) {
            Some("Série")
        } else if KIND_DESENHO.is_match(&type_text) {
            Some("Desenho")
        } else if KIND_FILME.is_match(&type_text) {
            Some("Filme")
        } else {
            None
        };
        let quality = CARD_QUALITY
            .captures(inner)
            .and_then(|c| strip_tags_ts(&c[1]).ok())
            .filter(|q| !q.is_empty());
        let poster = CARD_POSTER
            .captures(inner)
            .and_then(|c| decode_entities_ts(&c[1]).ok());
        out.push(HdrWork {
            url: resolved,
            title,
            year,
            poster,
            kind,
            quality,
        });
    }
    Ok(out)
}

// ─── saída ────────────────────────────────────────────────────────────────

/// Áudio do botão no título: DUBLADO, DUAL ou LEGENDADO (sem tamanho na tag).
fn audio_tag(link: &ResolverLink) -> Option<String> {
    match link.audio.as_deref() {
        Some("dublado") => Some("DUBLADO".into()),
        Some("dual") => Some("DUAL".into()),
        Some("legendado") => Some("LEGENDADO".into()),
        _ => None,
    }
}

const TITLE: ReleaseTitleConfig = ReleaseTitleConfig {
    with_size: false,
    audio_tag_of: Some(audio_tag),
    ..ReleaseTitleConfig::new(clean_post_title)
};

/// Feed torznab do HDR com a data de publicação injetada (paridade com
/// `apachetorrent::feed_with_date`). O `hdrRssXml` do TS carimba
/// `new Date().toUTCString()` em cada item; para o golden ser reprodutível,
/// a data entra por parâmetro.
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
        r#"<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>HDR Torrents</title>{body}</channel></rss>"#
    )
}

/// `Date.prototype.toUTCString()` — wrapper do núcleo `br_core::http_date`.
/// Fica público porque `tests/hdrtorrents_golden.rs` o usa como asserts.
pub fn utc_date(epoch_secs: i64) -> String {
    http_date_secs(epoch_secs)
}

/// `new Date().toUTCString()`: o relógio que o TS carimba em cada item.
fn utc_now() -> String {
    http_date_now()
}

/// Página sintética do Cardigann: o href de cada linha É o magnet (sem /resolve).
/// Não usa o `search_page_html` do núcleo: o layout tem a linha `post` e o
/// tamanho sentinela, e a descrição cai no título do post.
fn search_page(items: &[SearchItem]) -> String {
    let rows: String = items
        .iter()
        .map(|item| {
            let title = release_title(&TITLE, &item.post, &item.link, Some(item.index));
            let description = match item.link.description.as_deref().filter(|d| !d.is_empty()) {
                Some(d) => d.to_string(),
                None => item.post.title.clone(),
            };
            let size = item
                .link
                .size
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(UNKNOWN_SIZE);
            format!(
                r#"<div class="release"><div class="title"><a href="{}">{}</a></div><div class="size">{}</div><div class="post"><a href="{}">{}</a></div><div class="description">{}</div><div class="seeders">1</div></div>"#,
                escape_xml(&item.link.url),
                escape_xml(&title),
                escape_xml(size),
                escape_xml(&item.post.url),
                escape_xml(&item.post.url),
                escape_xml(&description),
            )
        })
        .collect();
    format!(r#"<!doctype html><html><body><div class="posts">{rows}</div></body></html>"#)
}

impl SiteOutput for Hdr {
    fn name(&self) -> &'static str {
        "hdrtorrents"
    }

    fn post_links(&self, html: &str, _post_url: &str) -> Result<Vec<ResolverLink>, String> {
        // Delega ao núcleo compartilhado (`br_core::hdr`, via fachada `common`).
        Ok(crate::common::hdr::parse_content_magnets(html))
    }

    fn release_title(&self, post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String {
        release_title(&TITLE, post, link, index)
    }

    fn search_page_html(&self, _self_url: &str, items: &[SearchItem]) -> String {
        search_page(items)
    }

    fn rss_xml(&self, _self_url: &str, items: &[SearchItem], category: u32) -> Option<String> {
        Some(feed_with_date(items, category, &utc_now()))
    }
}
