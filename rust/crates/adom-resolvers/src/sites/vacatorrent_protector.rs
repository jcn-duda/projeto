//! Protetor do VacaTorrent (`vacatorrent-parsers.ts::createNextProtectedUrl`,
//! `magnet-extract.ts::discoverNextUrl`, `text.ts::extractMetaRefresh`): a
//! cadeia real é `go.php` → `processar.php` → `t.co` → `relay.php`, e `t.co`/
//! `vacadb.org` são hosts SÓ de passagem (assert-only): valem como próximo
//! salto, nunca como botão.

use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use url::Url;

use crate::common::release::FB;
use crate::common::text::decode_entities;
use crate::sites::host_matches;

/// Protetores do vaca: base do TS + `systemtech.space`.
pub const VACA_PROTECTORS: &[&str] = &[
    "systemads1.com",
    "systemads.net",
    "videosad.net",
    "canalfutebol.com",
    "temreceita.com",
    "systemtech.space",
];
/// `ASSERT_ONLY_SUFFIXES`.
pub const VACA_ASSERT_ONLY: &[&str] = &["t.co", "vacadb.org"];

fn is_protector(host: &str) -> bool {
    host_matches(host, VACA_PROTECTORS)
}

fn is_hop_host(host: &str) -> bool {
    is_protector(host) || host_matches(host, VACA_ASSERT_ONLY)
}

/// `new URL(value, base).href`.
fn resolve(value: &str, base: &str) -> Option<Url> {
    match Url::parse(base) {
        Ok(b) => b.join(value).ok(),
        Err(_) => Url::parse(value).ok(),
    }
}

/// `isDifferentUrl`: sem fragmento e sem barra final, o destino não é a base.
fn is_different(dest: &str, base: &str) -> bool {
    let clean = |u: &str| {
        let no_hash = u.split('#').next().unwrap_or("");
        no_hash.trim_end_matches('/').to_string()
    };
    clean(dest) != clean(base)
}

/// `.replace(/\\\//g, '/').replace(/\\"/g, '"')` do valor JSON-escapado.
fn json_unescape(value: &str) -> String {
    value.replace("\\/", "/").replace("\\\"", "\"")
}

static NEXT_VAR: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(
        r#"(?i)(?:(?:const|let|var)\s+|window\.)?(?<![-\w])next\s*=\s*["'`]([^"'`]+)["'`]"#,
    )
    .expect("regex next=")
});
static ETAPA2: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)URL_ETAPA2\s*=\s*["'`]([^"'`]+)["'`]"#).expect("regex URL_ETAPA2")
});
static YOUTUBE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?:^|\.)youtube(?:-nocookie)?\.com$").expect("youtube"));
static ENCODED_HTTP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^https?%3A%2F%2F").expect("http codificado"));
/// `JS_URL_VAR_RE` do vaca (lista própria, `/i` sem `/g`: só o 1º match).
static JS_URL_VAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:DEST_URL|DOWNLOAD_URL|REDIRECT_URL|NEXT_URL|LOCATION|next_url|target_url|dest|target|link|url|next)\s*[:=]\s*["'](https?://[^"']+)["']"#)
        .expect("regex variável JS")
});
static META_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<meta(?-u:\b)[^>]*>").expect("meta"));
static REFRESH: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(r#"(?i){FB}http-equiv\s*=\s*["']?refresh["']?"#)).expect("refresh")
});
static CONTENT: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(
        r#"(?i){FB}content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#
    ))
    .expect("content")
});
static REFRESH_URL: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(
        r#"(?i){FB}url\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))"#
    ))
    .expect("url=")
});
static QUOTES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^['"]|['"]$"#).expect("aspas"));

fn first_group(caps: &fancy_regex::Captures<'_, str>) -> String {
    (1..=3)
        .find_map(|g| caps.get(g).map(|m| m.as_str().to_string()))
        .unwrap_or_default()
}

/// `extractMetaRefresh(html, decodeEntities)` do `text.ts`.
pub fn extract_meta_refresh(html: &str) -> Option<String> {
    for tag in META_TAG.find_iter(html) {
        let tag = tag.as_str();
        if !REFRESH.is_match(tag).unwrap_or(false) {
            continue;
        }
        let Ok(Some(content)) = CONTENT.captures(tag) else {
            continue;
        };
        let content = decode_entities(&first_group(&content));
        if let Ok(Some(url)) = REFRESH_URL.captures(content.as_str()) {
            let target = QUOTES
                .replace_all(first_group(&url).trim(), "")
                .into_owned();
            if !target.is_empty() {
                return Some(decode_entities(&target));
            }
        }
    }
    None
}

/// `discoverNextUrl` com a variável JS do vaca e os sufixos de protetor.
fn discover_next_url(html: &str, base: &str) -> Option<String> {
    if let Some(c) = JS_URL_VAR.captures(html) {
        if let Some(u) = resolve(&decode_entities(&c[1]), base) {
            if is_protector(u.host_str().unwrap_or("")) && u.as_str() != base {
                return Some(u.to_string());
            }
        }
    }
    let escaped: Vec<String> = VACA_PROTECTORS.iter().map(|s| regex::escape(s)).collect();
    let re = Regex::new(&format!(
        r#"(?i)https?://[^"'<>\s]*?(?:{})[^"'<>\s]*"#,
        escaped.join("|")
    ))
    .ok()?;
    let found = re.find(html)?;
    let u = resolve(&decode_entities(found.as_str()), base)?;
    (is_protector(u.host_str().unwrap_or("")) && u.as_str() != base).then(|| u.to_string())
}

/// Destino de um valor de `next =`: o redirect do YouTube (`?q=`) é aberto.
fn next_target(raw: &str, base: &str) -> Option<String> {
    let u = resolve(&decode_entities(&json_unescape(raw)), base)?;
    if YOUTUBE.is_match(u.host_str().unwrap_or("")) {
        let q = u
            .query_pairs()
            .find(|(k, _)| k == "q")
            .map(|(_, v)| v.into_owned())?;
        if q.trim().is_empty() {
            return None;
        }
        let mut target = decode_entities(q.trim());
        if ENCODED_HTTP.is_match(&target) {
            if let Some(decoded) = adom_crawl::shared::decode_uri_component(&target) {
                target = decoded;
            }
        }
        let dest = resolve(&target, base)?;
        return (is_hop_host(dest.host_str().unwrap_or("")) && is_different(dest.as_str(), base))
            .then(|| dest.to_string());
    }
    (is_hop_host(u.host_str().unwrap_or("")) && is_different(u.as_str(), base))
        .then(|| u.to_string())
}

/// `nextProtectedUrl(html, baseUrl)` do vaca.
pub fn next_protected_url(html: &str, base: &str) -> Option<String> {
    if html.is_empty() {
        return None;
    }
    for caps in NEXT_VAR.captures_iter(html).flatten() {
        if let Some(found) = caps.get(1).and_then(|m| next_target(m.as_str(), base)) {
            return Some(found);
        }
    }
    for caps in ETAPA2.captures_iter(html) {
        if let Some(u) = resolve(&decode_entities(&json_unescape(&caps[1])), base) {
            if is_hop_host(u.host_str().unwrap_or("")) && is_different(u.as_str(), base) {
                return Some(u.to_string());
            }
        }
    }
    if let Some(refresh) = extract_meta_refresh(html) {
        if let Some(u) = resolve(&decode_entities(&refresh), base) {
            if is_hop_host(u.host_str().unwrap_or("")) && is_different(u.as_str(), base) {
                return Some(u.to_string());
            }
        }
    }
    discover_next_url(html, base).filter(|d| is_different(d, base))
}
