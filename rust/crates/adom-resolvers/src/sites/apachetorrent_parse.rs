//! Parsers puros do Apache Torrent (`resolvers/profiles/apachetorrent-parsers.ts`):
//! token do form da home, cards da busca, botões de magnet do post, áudio e
//! validação de magnet.
//!
//! Paridade com o JS: `\b` é a fronteira ASCII (`(?-u:\b)`) e `\d` vira `[0-9]`.
//! `decodeURIComponent` é o `decode_uri_component` abaixo (estrito: `%` mal
//! formado ou UTF-8 quebrado devolve None, como o throw do JS).
//!
//! Não usa o `parse_post_magnets` do adom-crawl: ele normaliza o magnet (decodifica
//! entidades de novo e troca espaço por `%20`), lê `dn` com `query_pairs` (último
//! vence, o TS pega o primeiro) e classifica áudio por outra regra. O TS não faz
//! nada disso.

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::common::text::decode_entities;
use crate::common::text::strip_tags;
use adom_crawl::profile_parsers::ResolverLink;
use regex::Regex;
use url::Url;

use crate::common::page::SitePost;
use crate::common::rules::{normalize_quality, normalize_source};

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
            title,
            url,
            poster: None,
            date: None,
            year,
        });
    }
    out
}

// ─── áudio, qualidade e magnet ───────────────────────────────────────────

static LEG: LazyLock<Regex> = LazyLock::new(|| rx(r"LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)"));
static DUAL: LazyLock<Regex> =
    LazyLock::new(|| rx(r"DUAL[-\s]*[AÁ]UDIO|AUDIO[-\s]*DUPLO|DUPLO[-\s]*AUDIO"));
static DUB: LazyLock<Regex> = LazyLock::new(|| rx(r"DUBLAD|{B}DUB{B}|NACIONAL|PORTUGU[ÊE]S"));
static QUALITY_TEXT: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i){B}[0-9]{3,4}\s*p{B}"));
static MAGNET_PREFIX: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^magnet:"));
static XT_PARAM: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^xt\s*=\s*urn:btih:([^;&\s]+)"));
static HASH_HEX40: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^[0-9a-f]{40}$"));
static HASH_B32: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^[a-z2-7]{32}$"));
static HAS_SCHEME: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^[a-z][a-z0-9+.-]*:"));

/// `classifyAudio`: "LEGENDADO" vence; "DUAL ÁUDIO" vence "DUBLADA"; sem marcador, None.
pub fn classify_audio(context: &str) -> Option<&'static str> {
    let text = context.to_uppercase();
    if LEG.is_match(&text) {
        return Some("legendado");
    }
    if DUAL.is_match(&text) {
        return Some("dual");
    }
    if DUB.is_match(&text) {
        return Some("dublado");
    }
    None
}

/// `qualityFromText`: primeiro `NNNp` do texto (usado no `dn` do magnet).
pub fn quality_from_text(text: &str) -> Option<u32> {
    QUALITY_TEXT
        .find(text)
        .and_then(|m| normalize_quality(m.as_str()))
}

/// `decodeURIComponent` estrito: `%` sem dois hexadecimais ou UTF-8 inválido é None.
pub fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            let digits = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(digits, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `magnetParams(magnet).dn`: `decodeURIComponent(searchParams.get('dn') || '')`,
/// com falha (magnet inválido ou escape ruim) virando string vazia.
fn magnet_dn(magnet: &str) -> String {
    let Ok(url) = Url::parse(magnet) else {
        return String::new();
    };
    let raw = url
        .query_pairs()
        .find(|(key, _)| key == "dn")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    decode_uri_component(&raw).unwrap_or_default()
}

fn is_valid_btih_hash(hash: &str) -> bool {
    HASH_HEX40.is_match(hash) || HASH_B32.is_match(hash)
}

/// `isValidMagnetUri`: começa com `magnet:` e TODO `xt=urn:btih:` da query tem
/// hash válido (40 hex ou 32 base32); sem nenhum `xt` btih, é inválido.
pub fn is_valid_magnet_uri(value: &str) -> bool {
    if !MAGNET_PREFIX.is_match(value) {
        return false;
    }
    let query = value.find('?').map_or("", |q| &value[q + 1..]);
    let mut found = false;
    for param in query.split('&') {
        let Some(caps) = XT_PARAM.captures(param) else {
            continue;
        };
        if !is_valid_btih_hash(&caps[1]) {
            return false;
        }
        found = true;
    }
    found
}

// ─── botões do post ──────────────────────────────────────────────────────

static BLOCK_SPLIT: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)<div[^>]*class=["'][^"']*download-block[^"']*["'][^>]*>"#));
static VERSAO: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)class=["']download-versao["'][^>]*>([\s\S]*?)</p>"#));
static DESC: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)class=["']download-desc["'][^>]*>([\s\S]*?)</p>"#));
static ANCHOR_BLOCK: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)<a{B}[\s\S]*?</a>"));
static HREF_ANCHOR: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)<a{B}[^>]*{B}href=["']([^"']+)["']"#));

/// `parsePostMagnets`: cada `div.download-block` tem um grupo de âncoras magnet
/// com o contexto de áudio/qualidade em `p.download-desc` (e `p.download-versao`).
/// Só magnet válido entra; o href vira o próprio magnet (relativo resolve contra
/// a URL do post, sem normalizar o magnet).
pub fn parse_post_magnets(html: &str, post_url: &str) -> Vec<ResolverLink> {
    let mut out = Vec::new();
    if html.is_empty() {
        return out;
    }
    for block in BLOCK_SPLIT.split(html).skip(1) {
        let version = VERSAO
            .captures(block)
            .map(|c| strip_tags(&c[1]))
            .unwrap_or_default();
        let desc_raw = DESC
            .captures(block)
            .map(|c| c[1].to_string())
            .unwrap_or_default();
        let desc = strip_tags(&ANCHOR_BLOCK.replace_all(&desc_raw, " "));
        let context = format!("{version} {desc}");
        let audio = classify_audio(&context);
        let quality = normalize_quality(&context);
        let source = normalize_source(&context);
        let description = [version.as_str(), desc.as_str()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" — ");
        let description = (!description.is_empty()).then_some(description);

        for caps in HREF_ANCHOR.captures_iter(block) {
            let mut href = decode_entities(&caps[1]);
            if !post_url.is_empty() && !HAS_SCHEME.is_match(&href) {
                if let Some(joined) = resolve_url(&href, post_url) {
                    href = joined;
                }
            }
            if !is_valid_magnet_uri(&href) {
                continue;
            }
            let dn = magnet_dn(&href);
            out.push(ResolverLink {
                url: href,
                quality: quality.or_else(|| quality_from_text(&dn)),
                size: None,
                audio: audio.map(String::from),
                source: source.clone().or_else(|| normalize_source(&dn)),
                episode: None,
                episode_last: None,
                season: None,
                real_title: None,
                description: description.clone(),
            });
        }
    }
    out
}
