//! Parsers do visualizador (HTML) para sitemaps.

use regex::Regex;
use std::sync::LazyLock;

use crate::sitemap::types::SitemapEntry;
use adom_core::decode_entities;

static VIEWER_ROW_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)<tr>\s*<td>\s*<a\s+href="([^"]+)"[^>]*>[^<]*</a>\s*</td>(?:\s*<td>\s*\d+\s*</td>)?\s*<td>\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\s*([+-]\d{2}:?\d{2}|Z)?\s*</td>\s*</tr>"#
    ).unwrap()
});

/// Pares loc/lastmod da tabela do viewer do Yoast (`vaca-sitemap-viewer.ts:11`).
pub fn parse_viewer_entries(html: &str) -> Vec<SitemapEntry> {
    let mut out = Vec::new();
    for caps in VIEWER_ROW_RE.captures_iter(html) {
        let href = caps.get(1).map_or("", |m| m.as_str());
        let date = caps.get(2).map_or("", |m| m.as_str());
        let time = caps.get(3).map_or("", |m| m.as_str());
        let tz = match caps.get(4).map(|m| m.as_str()) {
            Some(s) if s != "Z" => {
                if s.contains(':') {
                    s.to_string()
                } else if s.len() >= 5 {
                    format!("{}:{}", &s[..3], &s[3..])
                } else {
                    "+00:00".to_string()
                }
            }
            _ => "+00:00".to_string(),
        };
        let loc = decode_entities(href);
        let lastmod = format!("{date}T{time}:00{tz}");
        out.push(SitemapEntry { loc, lastmod });
    }
    out
}

static ISO_DATE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4})-(\d{2})-(\d{2})$").unwrap());

static DATE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(\d{1,2})\s+(?:de\s+)?([A-Za-z]{3,9})\.?,?\s+(?:de\s+)?(\d{4})$").unwrap()
});

static TIME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$").unwrap());

/// Converte data do visualizador AIOSEO para ISO UTC (`redetorrent-discovery.ts:278`).
pub fn parse_rendered_lastmod(date_raw: &str, time_raw: Option<&str>) -> String {
    let raw = date_raw.trim();
    if raw.is_empty() || raw == "0000-00-00" {
        return String::new();
    }

    let (year, month, day) = if let Some(caps) = ISO_DATE_RE.captures(raw) {
        let y = caps[1].parse::<u32>().unwrap_or(0);
        let m = caps[2].parse::<u32>().unwrap_or(0);
        let d = caps[3].parse::<u32>().unwrap_or(0);
        (y, m, d)
    } else if let Some(caps) = DATE_RE.captures(raw) {
        let d = caps[1].parse::<u32>().unwrap_or(0);
        let m_str = caps[2].to_lowercase();
        let m = match m_str.as_str() {
            "january" | "jan" => 1,
            "february" | "feb" => 2,
            "march" | "mar" => 3,
            "april" | "apr" => 4,
            "may" => 5,
            "june" | "jun" => 6,
            "july" | "jul" => 7,
            "august" | "aug" => 8,
            "september" | "sep" => 9,
            "october" | "oct" => 10,
            "november" | "nov" => 11,
            "december" | "dec" => 12,
            _ => 0,
        };
        let y = caps[3].parse::<u32>().unwrap_or(0);
        (y, m, d)
    } else {
        return String::new();
    };

    if month == 0 || month > 12 || day == 0 || day > 31 || !(1900..=2100).contains(&year) {
        return String::new();
    }

    let (hh, mm, ss) = if let Some(t_str) = time_raw {
        let trimmed = t_str.trim();
        if let Some(caps) = TIME_RE.captures(trimmed) {
            let h = caps[1].parse::<u32>().unwrap_or(0).min(23);
            let m = caps[2].parse::<u32>().unwrap_or(0).min(59);
            let s = caps
                .get(3)
                .and_then(|c| c.as_str().parse::<u32>().ok())
                .unwrap_or(0)
                .min(59);
            (h, m, s)
        } else {
            (0, 0, 0)
        }
    } else {
        (0, 0, 0)
    };

    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

static REDE_ROW_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<tr\b[^>]*>(.*?)</tr>").unwrap());
static REDE_URL_CELL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<td\b[^>]*\bclass="[^"]*\bleft\b[^"]*"[^>]*>(.*?)</td>"#).unwrap()
});
static REDE_HREF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']"#).unwrap());
static REDE_DATE_DIV_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<div\b[^>]*\bclass="[^"]*\bdate\b[^"]*"[^>]*>(.*?)</div>"#).unwrap()
});
static REDE_TIME_DIV_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<div\b[^>]*\bclass="[^"]*\btime\b[^"]*"[^>]*>(.*?)</div>"#).unwrap()
});

/// Pares loc/lastmod da tabela do visualizador do RedeTorrent (`redetorrent-discovery.ts:207`).
pub fn parse_redetorrent_viewer_entries(html: &str) -> Vec<SitemapEntry> {
    let mut out = Vec::new();
    for row_cap in REDE_ROW_RE.captures_iter(html) {
        let body = row_cap.get(1).map_or("", |m| m.as_str());
        let cell = REDE_URL_CELL_RE
            .captures(body)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());
        let href = REDE_HREF_RE
            .captures(cell)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());
        let url = adom_core::decode_entities(href).trim().to_string();
        if url.is_empty() {
            continue;
        }

        let date_div = REDE_DATE_DIV_RE
            .captures(body)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());
        let time_div = REDE_TIME_DIV_RE
            .captures(body)
            .and_then(|c| c.get(1))
            .map_or("", |m| m.as_str());

        let date_text = cell_text(date_div);
        let time_text = cell_text(time_div);
        let lastmod = parse_rendered_lastmod(&date_text, Some(&time_text));

        out.push(SitemapEntry { loc: url, lastmod });
    }
    out
}

fn cell_text(raw: &str) -> String {
    static TAG_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").unwrap());
    let stripped = TAG_RE.replace_all(raw, " ");
    let decoded = decode_entities(&stripped);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}
