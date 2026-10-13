//! Parsers de listagem de busca por site BR.
//!
//! Cada parser extrai posts (title + url + poster opcional) do HTML de busca.
//! Portado de `resolvers/profiles/*-parsers.ts` — apenas a função de listagem.

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

use adom_crawl::resolver_matching::is_generic_list_post;
use adom_crawl::resolver_text::strip_tags;

/// Post extraído da listagem de busca (title + url).
#[derive(Debug, Clone)]
pub struct ListingPost {
    pub title: String,
    pub url: String,
    pub poster: Option<String>,
}

/// Parser de listagem por site. Retorna os posts extraídos do HTML.
pub fn parse_listing_posts(site_name: &str, html: &str, base_url: &str) -> Vec<ListingPost> {
    let s = site_name.to_lowercase();
    if s.contains("comando") {
        parse_comando_posts(html, base_url)
    } else if s.contains("torrentdosfilmes") {
        parse_tdf_posts(html, base_url)
    } else if s.contains("nerdfilmes") {
        parse_nerd_posts(html, base_url)
    } else if s.contains("bludv") {
        parse_bludv_posts(html, base_url)
    } else if s.contains("vaca") {
        parse_vaca_posts(html, base_url)
    } else if s.contains("apache") {
        parse_apache_posts(html, base_url)
    } else if s.contains("hdr") {
        parse_hdr_posts(html, base_url)
    } else if s.contains("rede") {
        parse_rede_posts(html, base_url)
    } else {
        Vec::new()
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

fn extract_attr(tag: &str, name: &str) -> Option<String> {
    let re = Regex::new(&format!(r#"(?i)\b{name}\s*=\s*["']([^"']+)["']"#)).ok()?;
    let caps = re.captures(tag)?;
    Some(adom_core::decode_entities(caps.get(1)?.as_str()))
}

fn resolve_url(href: &str, base: &str) -> Option<String> {
    let base_parsed = url::Url::parse(base).ok()?;
    Some(base_parsed.join(href).ok()?.as_str().to_string())
}

fn title_or_generic(attrs: &str, inner: &str) -> Option<String> {
    let title = extract_attr(attrs, "title")
        .map(|t| strip_tags(&t))
        .unwrap_or_else(|| strip_tags(inner));
    if title.is_empty() || is_generic_list_post(&title) {
        None
    } else {
        Some(title)
    }
}

// ── Comandotorrents (WordPress blog-view → h2.entry-title > a) ──────

static RE_COMANDO_ART: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)<article\b[^>]*class=["'][^"']*\bblog-view\b[^"']*["'][^>]*>([\s\S]*?)</article>"#,
    )
    .expect("ok")
});
static RE_COMANDO_A: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<h2\b[^>]*class=["'][^"']*\bentry-title\b[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)</a>"#).expect("ok")
});
static RE_COMANDO_IMG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<img\b[^>]*src=["']([^"']+)["']"#).expect("ok"));

fn parse_comando_posts(html: &str, base_url: &str) -> Vec<ListingPost> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for caps in RE_COMANDO_ART.captures_iter(html) {
        let block = caps.get(1).map_or("", |m| m.as_str());
        let Some(a) = RE_COMANDO_A.captures(block) else {
            continue;
        };
        let attrs = a.get(1).map_or("", |m| m.as_str());
        let Some(url) = extract_attr(attrs, "href").and_then(|h| resolve_url(&h, base_url)) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        let inner = a.get(2).map_or("", |m| m.as_str());
        let Some(title) = title_or_generic(attrs, inner) else {
            continue;
        };
        let poster = RE_COMANDO_IMG
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| adom_core::decode_entities(m.as_str()));
        out.push(ListingPost { title, url, poster });
    }
    out
}

// ── TorrentDosFilmes (WordPress ComandoFilmes: div.title > a) ───────

static RE_TDF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)<div\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)</a>"#,
    )
    .expect("ok")
});

fn parse_tdf_posts(html: &str, base_url: &str) -> Vec<ListingPost> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for caps in RE_TDF.captures_iter(html) {
        let attrs = caps.get(1).map_or("", |m| m.as_str());
        let Some(url) = extract_attr(attrs, "href").and_then(|h| resolve_url(&h, base_url)) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        let inner = caps.get(2).map_or("", |m| m.as_str());
        let Some(title) = title_or_generic(attrs, inner) else {
            continue;
        };
        out.push(ListingPost {
            title,
            url,
            poster: None,
        });
    }
    out
}

// ── NerdFilmes (article.col → .image > a[href][title]) ──────────────

static RE_NERD_ART: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<article\b[^>]*class=["'][^"']*\bcol\b[^"']*["'][^>]*>([\s\S]*?)</article>"#)
        .expect("ok")
});
static RE_NERD_IMG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<div\b[^>]*class=["'][^"']*\bimage\b[^"']*["'][^>]*>([\s\S]*?)</div>"#)
        .expect("ok")
});
static RE_NERD_A: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<a\b[^>]*>").expect("ok"));

fn parse_nerd_posts(html: &str, base_url: &str) -> Vec<ListingPost> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for caps in RE_NERD_ART.captures_iter(html) {
        let block = caps.get(1).map_or("", |m| m.as_str());
        let Some(img) = RE_NERD_IMG.captures(block) else {
            continue;
        };
        let inner = img.get(1).map_or("", |m| m.as_str());
        let Some(m) = RE_NERD_A.find(inner) else {
            continue;
        };
        let tag = m.as_str();
        let Some(url) = extract_attr(tag, "href").and_then(|h| resolve_url(&h, base_url)) else {
            continue;
        };
        let Some(title) = extract_attr(tag, "title").map(|t| strip_tags(&t)) else {
            continue;
        };
        if title.is_empty() || is_generic_list_post(&title) {
            continue;
        }
        if !seen.insert(url.clone()) {
            continue;
        }
        out.push(ListingPost {
            title,
            url,
            poster: None,
        });
    }
    out
}

// ── BLUDV (div.post → div.title > a[href]) ──────────────────────────

static RE_BLUDV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<div class="post">[\s\S]*?<div class="title">\s*<a\s+[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)</a>"#).expect("ok")
});
static RE_BLUDV_IMG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<img[^>]+src="([^"]+)""#).expect("ok"));

fn parse_bludv_posts(html: &str, base_url: &str) -> Vec<ListingPost> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for caps in RE_BLUDV.captures_iter(html) {
        let raw = caps.get(1).map_or("", |m| m.as_str()).trim();
        let Some(url) = resolve_url(raw, base_url) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        let inner = caps.get(2).map_or("", |m| m.as_str());
        let title = strip_tags(inner);
        if title.is_empty() || is_generic_list_post(&title) {
            continue;
        }
        let start = caps.get(0).map_or(0, |m| m.start());
        let block = &html[start..html.len().min(start + 8000)];
        let poster = RE_BLUDV_IMG
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        out.push(ListingPost { title, url, poster });
    }
    out
}

// ── VacaTorrent (AJAX JSON) ─────────────────────────────────────────

fn parse_vaca_posts(text: &str, base_url: &str) -> Vec<ListingPost> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let cleaned = text.trim();
    let json_text = if cleaned.starts_with('<') {
        strip_tags(cleaned)
    } else {
        cleaned.to_string()
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json_text) else {
        return out;
    };
    let arr = match &parsed {
        serde_json::Value::Array(a) => a.clone(),
        serde_json::Value::Object(o) => o
            .get("results")
            .or_else(|| o.get("posts"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => return out,
    };
    for item in arr {
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .map(strip_tags)
            .unwrap_or_default();
        let link = item
            .get("link")
            .or_else(|| item.get("url"))
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        if title.is_empty() || link.is_empty() {
            continue;
        }
        let Some(url) = resolve_url(link, base_url) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        if is_generic_list_post(&title) {
            continue;
        }
        let poster = item
            .get("thumbnail")
            .and_then(|v| v.as_str())
            .map(adom_core::decode_entities);
        out.push(ListingPost { title, url, poster });
    }
    out
}

// ── ApacheTorrent (PHP: div.capa-item → h2.capa-titulo > a) ─────────

static RE_APA_CHUNK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<div class=["']capa-item["']>"#).expect("ok"));
static RE_APA_A: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<h2 class=["']capa-titulo["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)</a>"#)
        .expect("ok")
});

fn parse_apache_posts(html: &str, base_url: &str) -> Vec<ListingPost> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut pos = 0;
    while let Some(m) = RE_APA_CHUNK.find_at(html, pos) {
        let start = m.end();
        let end = RE_APA_CHUNK
            .find_at(html, start)
            .map_or(html.len(), |n| n.start());
        let chunk = &html[start..end];
        pos = end;
        let Some(a) = RE_APA_A.captures(chunk) else {
            continue;
        };
        let attrs = a.get(1).map_or("", |m| m.as_str());
        let Some(url) = extract_attr(attrs, "href").and_then(|h| resolve_url(&h, base_url)) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        let inner = a.get(2).map_or("", |m| m.as_str());
        let attr_title = extract_attr(attrs, "title");
        let title = strip_tags(attr_title.as_deref().unwrap_or(inner));
        if title.is_empty() || is_generic_list_post(&title) {
            continue;
        }
        out.push(ListingPost {
            title,
            url,
            poster: None,
        });
    }
    out
}

// ── HDRTorrents (a.media-card-link → .media-card-title) ─────────────

static RE_HDR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b[^>]*?\bhref=["']([^"']+)["'][^>]*?\bclass=["'][^"']*media-card-link[^"']*["'][^>]*>([\s\S]*?)</a>"#).expect("ok")
});
static RE_HDR_T: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)class=["'][^"']*media-card-title[^"']*["'][\s\S]*?>([\s\S]*?)$"#)
        .expect("ok")
});
static RE_HDR_P: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)class=["'][^"']*media-card-cover[^"']*["'][\s\S]*?>\s*<img[\s\S]*?\b(?:data-)?src=["']([^"']+)["']"#).expect("ok")
});

fn parse_hdr_posts(html: &str, base_url: &str) -> Vec<ListingPost> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for caps in RE_HDR.captures_iter(html) {
        let href = caps.get(1).map_or("", |m| m.as_str());
        let inner = caps.get(2).map_or("", |m| m.as_str());
        let Some(url) = resolve_url(href, base_url) else {
            continue;
        };
        if url == base_url || url == format!("{base_url}/") {
            continue;
        }
        if !seen.insert(url.clone()) {
            continue;
        }
        let title = RE_HDR_T
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| strip_tags(m.as_str()))
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }
        let poster = RE_HDR_P
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| adom_core::decode_entities(m.as_str()));
        out.push(ListingPost { title, url, poster });
    }
    out
}

// ── RedeTorrent (div.item > a[href][title]) ─────────────────────────

static RE_REDE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<div class="item">\s*<a\s+href=["']([^"']+)["']\s+title=["']([^"']*)["']"#)
        .expect("ok")
});

fn parse_rede_posts(html: &str, base_url: &str) -> Vec<ListingPost> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for caps in RE_REDE.captures_iter(html) {
        let href = caps.get(1).map_or("", |m| m.as_str());
        let Some(url) = resolve_url(href, base_url) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        let raw = caps.get(2).map_or("", |m| m.as_str());
        let title = adom_core::decode_entities(raw)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if title.is_empty() || is_generic_list_post(&title) {
            continue;
        }
        out.push(ListingPost {
            title,
            url,
            poster: None,
        });
    }
    out
}

// ── Testes ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn comando_extrai_posts() {
        let html = r#"<article class="blog-view"><h2 class="entry-title"><a href="/x" title="Filme X">X</a></h2><img src="i.jpg"></article>"#;
        let p = parse_comando_posts(html, "https://c.tv");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "Filme X");
        assert!(p[0].poster.is_some());
    }

    #[test]
    fn tdf_extrai_posts() {
        let html = r#"<div class="title"><a href="/y" title="Filme Y 2024">Y...</a></div>"#;
        let p = parse_tdf_posts(html, "https://tdf.com");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "Filme Y 2024");
    }

    #[test]
    fn hdr_extrai_card() {
        let html = r#"<a href="/z" class="media-card-link"><div class="media-card-cover"><img data-src="p.jpg"></div><div class="media-card-title">Filme Z</div></a>"#;
        let p = parse_hdr_posts(html, "https://hdr.net");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "Filme Z");
    }

    #[test]
    fn rede_extrai_item() {
        let html = r#"<div class="item"><a href="/filmes/f" title="Filme W (2023)">x</a></div>"#;
        let p = parse_rede_posts(html, "https://rede.com");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "Filme W (2023)");
    }

    #[test]
    fn vaca_extrai_json() {
        let json = r#"[{"title":"Obra A","link":"/obra-a","thumbnail":"i.jpg"}]"#;
        let p = parse_vaca_posts(json, "https://vaca.com");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "Obra A");
    }

    #[test]
    fn apache_extrai_capa() {
        let html = r#"<div class='capa-item'><h2 class='capa-titulo'><a href='/v' title='Filme V'>t</a></h2></div>"#;
        let p = parse_apache_posts(html, "https://apa.com");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "Filme V");
    }

    #[test]
    fn bludv_extrai_post() {
        let html = r#"<div class="post"><div class="title"><a href='/u'>Filme U</a></div></div>"#;
        let p = parse_bludv_posts(html, "https://bludv.com");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "Filme U");
    }

    #[test]
    fn nerd_extrai_article() {
        let html = r#"<article class="col"><div class="image"><a href="/t" title="Filme T"></a></div></article>"#;
        let p = parse_nerd_posts(html, "https://nerd.com");
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].title, "Filme T");
    }

    #[test]
    fn dispatch_e_genericos() {
        let html = r#"<div class="title"><a href="/x" title="Teste">x</a></div>"#;
        assert_eq!(
            parse_listing_posts("torrentdosfilmes", html, "https://tdf.com").len(),
            1
        );
        assert!(parse_listing_posts("desconhecido", html, "https://x.com").is_empty());
        let gen = r#"<div class="title"><a href="/l" title="Lista de Filmes 2024">L</a></div>"#;
        assert!(parse_tdf_posts(gen, "https://tdf.com").is_empty());
    }
}
