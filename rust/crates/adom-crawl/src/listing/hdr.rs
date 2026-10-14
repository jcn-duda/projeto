use super::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

// ── HDRTorrent (`hdrtorrents-discovery.ts`) ──────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HdrListingCard {
    pub url: String,
    pub title: String,
    pub year: Option<u32>,
    pub card_type: Option<String>,
    pub kind: CrawlPageKind,
}

pub fn hdr_is_work_path(href: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)^/[a-z0-9][a-z0-9-]*-torrent-download/$").unwrap());
    re.is_match(&extract_pathname(href))
}

pub fn hdr_is_season_slug(url_or_path: &str) -> bool {
    if url_or_path.is_empty() {
        return false;
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)-\d{1,2}a?-temporada").unwrap());
    re.is_match(&extract_pathname(url_or_path))
}

pub fn hdr_kind_from_card_type(card_type: Option<&str>) -> Option<CrawlPageKind> {
    let text = card_type?.to_lowercase();
    if text.is_empty() {
        return None;
    }
    static SERIE_RE: OnceLock<Regex> = OnceLock::new();
    static DESENHO_RE: OnceLock<Regex> = OnceLock::new();
    static FILME_RE: OnceLock<Regex> = OnceLock::new();

    let serie = SERIE_RE.get_or_init(|| Regex::new(r"(?i)s[ée]rie").unwrap());
    let desenho = DESENHO_RE.get_or_init(|| Regex::new(r"(?i)desenho|anima").unwrap());
    let filme = FILME_RE.get_or_init(|| Regex::new(r"(?i)filme").unwrap());

    if serie.is_match(&text) {
        Some(CrawlPageKind::TvShow)
    } else if desenho.is_match(&text) {
        None
    } else if filme.is_match(&text) {
        Some(CrawlPageKind::Movie)
    } else {
        None
    }
}

pub fn hdr_kind_from_work_slug(url_or_path: &str) -> CrawlPageKind {
    if hdr_is_season_slug(url_or_path) {
        CrawlPageKind::TvShow
    } else {
        CrawlPageKind::Movie
    }
}

pub fn hdr_count_listing_cards(html: &str) -> usize {
    static CARD_RE: OnceLock<Regex> = OnceLock::new();
    let card_re = CARD_RE.get_or_init(|| {
        Regex::new(r#"(?i)<a\b[^>]*\bclass=["'][^"']*\bmedia-card-link\b[^"']*["'][^>]*>"#).unwrap()
    });

    let cleaned = strip_closed_html_comments(html);
    card_re.find_iter(&cleaned).count()
}

pub fn hdr_page_kind_of(html: &str) -> Option<CrawlPageKind> {
    static MAIN_RE: OnceLock<Regex> = OnceLock::new();
    static MOVIE_RE: OnceLock<Regex> = OnceLock::new();
    static SERIES_RE: OnceLock<Regex> = OnceLock::new();

    let main_re = MAIN_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)<main\b[^>]*\bitemtype=["']https?://schema\.org/(Movie|TVSeries)["'][^>]*>"#,
        )
        .unwrap()
    });
    let movie_re = MOVIE_RE.get_or_init(|| Regex::new(r"(?i)/Movie").unwrap());
    let series_re = SERIES_RE.get_or_init(|| Regex::new(r"(?i)/TVSeries").unwrap());

    let cleaned = strip_html_comments(html);
    let matched = main_re.captures(&cleaned)?.get(0)?.as_str();

    if movie_re.is_match(matched) {
        Some(CrawlPageKind::Movie)
    } else if series_re.is_match(matched) {
        Some(CrawlPageKind::TvShow)
    } else {
        None
    }
}

pub fn hdr_declares_series(html: &str) -> bool {
    hdr_page_kind_of(html) == Some(CrawlPageKind::TvShow)
}

pub fn hdr_kind_conflict_of(html: &str, season: bool) -> Option<&'static str> {
    match (season, hdr_page_kind_of(html)) {
        (true, Some(CrawlPageKind::Movie)) => Some("filme_com_kind_tv_show: a ficha declara Movie"),
        (false, Some(CrawlPageKind::TvShow)) => {
            Some("serie_com_kind_movie: a ficha declara TVSeries")
        }
        _ => None,
    }
}

pub fn hdr_ficha_text(html: &str) -> String {
    static SEP_RE: OnceLock<Regex> = OnceLock::new();
    static DTDD_RE: OnceLock<Regex> = OnceLock::new();
    static TIME_RE: OnceLock<Regex> = OnceLock::new();

    let sep_re = SEP_RE.get_or_init(|| Regex::new(r#"(?is)<span class="sep">.*?</span>"#).unwrap());
    let dtdd_re = DTDD_RE.get_or_init(|| Regex::new(r"(?i)</?(?:dt|dd)\b[^>]*>").unwrap());
    let time_re = TIME_RE.get_or_init(|| Regex::new(r"(?i)</?time\b[^>]*>").unwrap());

    let s1 = sep_re.replace_all(html, " ");
    let s2 = dtdd_re.replace_all(&s1, " ");
    time_re.replace_all(&s2, " ").into_owned()
}

pub fn hdr_parse_imdb_id(html: &str) -> Option<String> {
    extract_single_imdb_id(&strip_html_comments(html))
}

pub fn hdr_listing_path(base: &str) -> String {
    if let Ok(parsed) = url::Url::parse(base) {
        parsed.path().to_string()
    } else {
        "/".to_string()
    }
}

pub fn hdr_parse_listing_cards(html: &str, base_url: &str) -> Vec<HdrListingCard> {
    static A_BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    static HREF_RE: OnceLock<Regex> = OnceLock::new();
    static TITLE_RE: OnceLock<Regex> = OnceLock::new();
    static YEAR_RE: OnceLock<Regex> = OnceLock::new();
    static TYPE_RE: OnceLock<Regex> = OnceLock::new();
    static TAG_RE: OnceLock<Regex> = OnceLock::new();

    let block_re = A_BLOCK_RE.get_or_init(|| {
        Regex::new(r#"(?is)<a\b[^>]*?\bclass=["'][^"']*media-card-link[^"']*["'][^>]*>(.*?)</a>"#)
            .unwrap()
    });
    let href_re = HREF_RE.get_or_init(|| Regex::new(r#"(?i)\bhref=["']([^"']+)["']"#).unwrap());
    let title_re = TITLE_RE.get_or_init(|| {
        Regex::new(
            r#"(?is)class=["'][^"']*media-card-title[^"']*["'][^>]*>(.*?)(?:</h3>|</article>|$)"#,
        )
        .unwrap()
    });
    let year_re = YEAR_RE.get_or_init(|| {
        Regex::new(r#"(?i)class=["'][^"']*media-card-year[^"']*["'][^>]*>\s*\(?(\d{4})\)?"#)
            .unwrap()
    });
    let type_re = TYPE_RE.get_or_init(|| {
        Regex::new(r#"(?i)class=["'][^"']*badge-tipo[^"']*["'][^>]*>(.*?)</(?:span|div|a)>"#)
            .unwrap()
    });
    let tag_re = TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());

    let cleaned = strip_closed_html_comments(html);
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for caps in block_re.captures_iter(&cleaned) {
        let whole_match = caps.get(0).map(|m| m.as_str()).unwrap_or("");
        let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");

        let raw_href = match href_re.captures(whole_match).and_then(|c| c.get(1)) {
            Some(h) => h.as_str(),
            None => continue,
        };
        let decoded_href = adom_core::decode_entities(raw_href);
        let resolved = match resolve_url(base_url, &decoded_href) {
            Some(r) => r,
            None => continue,
        };

        if seen.contains(&resolved) {
            continue;
        }
        if !hdr_is_work_path(&resolved) {
            continue;
        }
        seen.insert(resolved.clone());

        let raw_title = title_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
            .unwrap_or("");
        let title_no_tags = tag_re.replace_all(raw_title, " ");
        let title = adom_core::decode_entities(&title_no_tags)
            .trim()
            .to_string();

        let year: Option<u32> = year_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse().ok());

        let card_type = type_re
            .captures(inner)
            .and_then(|c| c.get(1))
            .map(|m| tag_re.replace_all(m.as_str(), " ").trim().to_string());

        let kind = hdr_kind_from_card_type(card_type.as_deref())
            .unwrap_or_else(|| hdr_kind_from_work_slug(&resolved));

        out.push(HdrListingCard {
            url: resolved,
            title,
            year,
            card_type,
            kind,
        });
    }

    out
}
