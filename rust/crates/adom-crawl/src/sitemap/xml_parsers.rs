//! Parsers de XML para sitemaps.

use regex::Regex;
use std::collections::HashMap;
use std::sync::LazyLock;
use url::Url;

use crate::sitemap::types::{SitemapEntry, SitemapParseOptions};
use adom_core::decode_entities;

static CDATA_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$").unwrap());

fn xml_text(raw: &str) -> String {
    let trimmed = raw.trim();
    let text = if let Some(caps) = CDATA_RE.captures(trimmed) {
        caps.get(1).map_or("", |m| m.as_str())
    } else {
        trimmed
    };
    decode_entities(text).trim().to_string()
}

fn normalize_lastmod(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "0000-00-00" || trimmed.starts_with("0000-") {
        return String::new();
    }
    if trimmed.len() >= 4 {
        if let Ok(year) = trimmed[..4].parse::<u32>() {
            if (1900..=2100).contains(&year) {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

static BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<(?:url|sitemap)\b[^>]*>(.*?)</(?:url|sitemap)>").unwrap());
static LOC_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<loc\b[^>]*>(.*?)</loc>").unwrap());
static LASTMOD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<lastmod\b[^>]*>(.*?)</lastmod>").unwrap());

/// Pares loc/lastmod de um sitemap (XML ou viewer Yoast do Vaca como fallback).
pub fn parse_sitemap_entries(xml: &str) -> Vec<SitemapEntry> {
    parse_sitemap_entries_with_options(xml, &SitemapParseOptions::default())
}

/// Parsing configurável de entradas de sitemap.
pub fn parse_sitemap_entries_with_options(
    xml: &str,
    options: &SitemapParseOptions,
) -> Vec<SitemapEntry> {
    let mut out = Vec::new();
    for block in BLOCK_RE.find_iter(xml) {
        let block_str = block.as_str();
        let loc_raw = match LOC_RE.captures(block_str) {
            Some(caps) => caps.get(1).map_or("", |m| m.as_str()),
            None => continue,
        };
        let loc = xml_text(loc_raw);
        if loc.is_empty() {
            continue;
        }

        let lastmod_raw = LASTMOD_RE
            .captures(block_str)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());
        let lastmod = if options.validate_date {
            normalize_lastmod(&xml_text(lastmod_raw))
        } else {
            xml_text(lastmod_raw)
        };

        out.push(SitemapEntry { loc, lastmod });
    }

    if out.is_empty() && options.fallback_to_viewer {
        let viewer_rows = crate::sitemap::viewer_parsers::parse_viewer_entries(xml);
        if !viewer_rows.is_empty() {
            return viewer_rows;
        }
        let rede_rows = crate::sitemap::viewer_parsers::parse_redetorrent_viewer_entries(xml);
        if !rede_rows.is_empty() {
            return rede_rows;
        }
    }

    out
}

/// Fusão de XML e visualizador para o RedeTorrent (`redetorrent-discovery.ts:236`).
pub fn parse_sitemap_rows(html: &str) -> Vec<SitemapEntry> {
    let mut by_url: HashMap<String, String> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    let mut xml_entries = parse_sitemap_entries_with_options(
        html,
        &SitemapParseOptions {
            fallback_to_viewer: false,
            validate_date: true,
        },
    );
    // Canonicaliza XML lastmod para formato UTC `Z` caso venha com `+00:00`
    for e in &mut xml_entries {
        if e.lastmod.ends_with("+00:00") {
            e.lastmod = format!("{}Z", &e.lastmod[..e.lastmod.len() - 6]);
        }
    }

    let viewer_entries = crate::sitemap::viewer_parsers::parse_redetorrent_viewer_entries(html);

    for entry in xml_entries.into_iter().chain(viewer_entries) {
        if let Some(existing_lastmod) = by_url.get_mut(&entry.loc) {
            if entry.lastmod > *existing_lastmod {
                *existing_lastmod = entry.lastmod;
            }
        } else {
            order.push(entry.loc.clone());
            by_url.insert(entry.loc, entry.lastmod);
        }
    }

    order
        .into_iter()
        .map(|loc| {
            let lastmod = by_url.remove(&loc).unwrap_or_default();
            SitemapEntry { loc, lastmod }
        })
        .collect()
}

static POST_SITEMAP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)/post-sitemap\d*\.xml$").unwrap());

/// Locs de `post-sitemap*` do índice, ignorando host alheio e deduplicando.
pub fn parse_sitemap_index_locs(
    xml: &str,
    base: &str,
    is_detail_host: impl Fn(&str) -> bool,
) -> Vec<String> {
    parse_sitemap_index_locs_matching(xml, base, is_detail_host, |path| {
        POST_SITEMAP_RE.is_match(path)
    })
}

/// Locs do índice que casem um filtro customizado de caminho.
pub fn parse_sitemap_index_locs_matching(
    xml: &str,
    base: &str,
    is_detail_host: impl Fn(&str) -> bool,
    path_filter: impl Fn(&str) -> bool,
) -> Vec<String> {
    let entries = parse_sitemap_entries(xml);
    let base_url = Url::parse(base).ok();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for entry in entries {
        let resolved = if let Some(ref b) = base_url {
            b.join(&entry.loc).ok()
        } else {
            Url::parse(&entry.loc).ok()
        };
        if let Some(href) = resolved {
            if path_filter(href.path()) {
                if let Some(host) = href.host_str() {
                    if is_detail_host(host) {
                        let full = href.to_string();
                        if seen.insert(full.clone()) {
                            out.push(full);
                        }
                    }
                }
            }
        }
    }
    out
}
