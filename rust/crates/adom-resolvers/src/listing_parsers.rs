//! Parsers de listagem de busca por site BR — são o **default** do gancho
//! `SiteOutput::search_posts`, não um caminho morto.
//!
//! Cada parser extrai posts (title + url + poster opcional) do HTML de busca. Portado
//! de `resolvers/profiles/*-parsers.ts` — apenas a função de listagem.
//!
//! Quem chega aqui:
//! - `sites/mod.rs` (default de `search_posts`): despacha pelo `SiteOutput::name()`.
//!   Dos oito sites, três NÃO sobrescrevem o gancho e herdam esta rota —
//!   `comandotorrents`, `hdrtorrents` e `vacatorrent`.
//! - `tests/comandotorrents_golden.rs`: chama `parse_listing_posts(SITE, ..)`
//!   direto, travando o default contra o golden gerado do TS.
//!
//! No fluxo HTTP, porém, só o Comando alcança este dispatch: `items.rs` abre
//! exceção para Apache, HDR e Vaca, que vão para `crate::flows` antes do gancho,
//! e os demais sites têm parser próprio em `crate::sites`. Como o `name()` chega
//! como string, o compilador não prova o ramo alcançável e `cargo clippy` não
//! marca nada aqui — por isso os outros ramos (tdf, nerd, bludv, vaca, apache,
//! hdr, rede) ficam cobertos pelos testes deste módulo e sobrevivem como
//! registro do formato de cada site. Remover um deles é decisão de porte (exige
//! comparar com o profile TS), não limpeza de código morto.
//!
//! O ramo do Vaca (`parse_vaca_posts`, que mora em `listing_vaca.rs` apenas para
//! este arquivo caber no teto de 400 linhas) lê o JSON da busca AJAX. A rota viva
//! do site é outra: `sites/vacatorrent_search.rs`, chamada por
//! `crate::flows::vaca` — por isso o ramo do dispatch não é a fonte de verdade do
//! Vaca, mas tampouco é morto: é o que `parse_listing_posts("vacatorrent", ..)`
//! devolve, e `listing_parsers_tests.rs` o trava.
//!
//! O ramo do TorrentGalaxy (`parse_torrentgalaxy_posts`, em
//! `listing_torrentgalaxy.rs`) devolve a linha RICA — tamanho, data, seeders e
//! poster; o magnet do TGx vive na página de DETALHE, não na listagem.

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

use adom_crawl::resolver_matching::is_generic_list_post;
use adom_crawl::resolver_text::strip_tags;

#[path = "listing_torrentgalaxy.rs"]
pub mod torrentgalaxy;
use torrentgalaxy::parse_torrentgalaxy_posts;
#[path = "listing_vaca.rs"]
mod vaca;
use vaca::parse_vaca_posts;

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
    } else if s.contains("torrentgalaxy") {
        // O TGx tem a listagem mais RICA (tamanho, data, seeders e poster na
        // linha; o magnet fica na página de detalhe). O parser mora em
        // `listing_torrentgalaxy.rs` porque este arquivo já está no teto.
        parse_torrentgalaxy_posts(html, base_url)
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
#[path = "listing_parsers_tests.rs"]
mod listing_parsers_tests;
