//! Parsers do Apache Torrent (`resolvers/profiles/apachetorrent-parsers.ts`):
//! token do form da home e cards da busca. O `parsePostMagnets` (botões do
//! post) mora em `br_core::apache` — compartilhado com o raspador.
//!
//! Paridade com o JS: `\b` é a fronteira ASCII (`(?-u:\b)`) e `\d` vira `[0-9]`.
//! `decodeURIComponent` é o `decode_uri_component` do `shared` (estrito: `%`
//! mal formado ou UTF-8 quebrado devolve None, como o throw do JS).

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::common::text::decode_entities;
use crate::common::text::strip_tags;
use adom_crawl::profile_parsers::ResolverLink;
use regex::Regex;
use url::Url;

use crate::common::page::SitePost;

const B: &str = r"(?-u:\b)";

fn rx(pattern: &str) -> Regex {
    Regex::new(&pattern.replace("{B}", B)).expect("regex do apachetorrent")
}

// ─── token do form da home ───────────────────────────────────────────────

static INPUT_TAG: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)<input{B}[^>]*>"));
static NAME_ATTR: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i){B}name=["']([^"']+)["']"#));
static VALUE_ATTR: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i){B}value=["']([^"']*)["']"#));

/// `extractSearchToken`: `<input name="token" value="...">` por tag, na ordem
/// do HTML. Valor vazio pula a tag; valor que só tem espaço vira `Some("")`,
/// como no TS (o `if (value)` olha o cru, o `trim` vem depois).
pub fn extract_search_token(html: &str) -> Option<String> {
    for tag in INPUT_TAG.find_iter(html) {
        let tag = tag.as_str();
        let Some(name) = NAME_ATTR.captures(tag).map(|c| c[1].to_string()) else {
            continue;
        };
        if name.to_lowercase() != "token" {
            continue;
        }
        let raw = VALUE_ATTR.captures(tag).map(|c| c[1].to_string());
        if let Some(value) = raw.filter(|v| !v.is_empty()) {
            return Some(decode_entities(&value).trim().to_string());
        }
    }
    None
}

// ─── cards da busca ──────────────────────────────────────────────────────

static CARD_SPLIT: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i)<div class=["']capa-item["']>"#));
static CARD_ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
    rx(r#"(?i)<h2 class=["']capa-titulo["'][^>]*>\s*<a{B}([^>]*)>([\s\S]*?)</a>"#)
});
static HREF_ATTR: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i){B}href=["']([^"']+)["']"#));
static TITLE_ATTR: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i){B}title=["']([^"']*)["']"#));
static YEAR_KIND: LazyLock<Regex> = LazyLock::new(|| {
    rx(r"(?i)\(\s*(?:Filme|S[ée]rie|Document[áa]rio|Anime|Desenho)\s+de\s+([0-9]{4})\s*\)")
});
static YEAR_PLAIN: LazyLock<Regex> = LazyLock::new(|| rx(r"\(([0-9]{4})\)"));

/// Resolve `href` contra `base` como `new URL(href, base)`. Base vazia vale só
/// para href absoluto; base inválida falha (o TS lança e o card é pulado).
fn resolve_url(href: &str, base: &str) -> Option<String> {
    if base.is_empty() {
        return Url::parse(href).ok().map(String::from);
    }
    Url::parse(base).ok()?.join(href).ok().map(String::from)
}

/// `parseSearchHtml`: cards `div.capa-item > h2.capa-titulo > a`, deduplicados
/// pela URL resolvida. O ano sai do marcador "(Filme de 2024)" ou de "(2024)".
/// O título vem do atributo `title` (sem o marcador) e cai no texto do link.
pub fn parse_search_posts(html: &str, base_url: &str) -> Vec<SitePost> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for chunk in CARD_SPLIT.split(html).skip(1) {
        let Some(anchor) = CARD_ANCHOR.captures(chunk) else {
            continue;
        };
        let attrs = &anchor[1];
        let Some(href) = HREF_ATTR.captures(attrs).map(|c| c[1].to_string()) else {
            continue;
        };
        let Some(url) = resolve_url(&decode_entities(&href), base_url) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        let text = strip_tags(&anchor[2]);
        let attr_title = TITLE_ATTR
            .captures(attrs)
            .map(|c| c[1].to_string())
            .filter(|t| !t.is_empty());
        let title = strip_tags(attr_title.as_deref().unwrap_or(&anchor[2]));
        if title.is_empty() {
            continue;
        }
        let year = YEAR_KIND
            .captures(&text)
            .or_else(|| YEAR_PLAIN.captures(&text))
            .and_then(|c| c[1].parse::<u32>().ok());
        out.push(SitePost {
            kind: None,
            title,
            url,
            poster: None,
            date: None,
            year,
        });
    }
    out
}

// ─── botões do post (delegação ao br_core) ───────────────────────────────

/// `parsePostMagnets`: delega ao núcleo compartilhado (`br_core::apache`).
/// A URL do post é usada para resolver hrefs relativos (mesmo caminho do TS).
pub fn parse_post_magnets(html: &str, post_url: &str) -> Vec<ResolverLink> {
    crate::common::apache::parse_post_magnets(html, post_url)
}
