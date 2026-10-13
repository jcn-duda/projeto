use super::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

// ── ApacheTorrents (`apachetorrent-discovery.ts`) ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApacheListingCard {
    pub url: String,
    pub kind: CrawlPageKind,
}

pub fn apache_is_work_path(href: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)^/[^/?#]+-baixar-torrent/$").unwrap());
    re.is_match(&extract_pathname(href))
}

pub fn apache_is_season_slug(url_or_path: &str) -> bool {
    if url_or_path.is_empty() {
        return false;
    }
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)-\d{1,2}a?-temporada").unwrap());
    re.is_match(&extract_pathname(url_or_path))
}

pub fn apache_kind_from_work_slug(url_or_path: &str) -> CrawlPageKind {
    if apache_is_season_slug(url_or_path) {
        CrawlPageKind::TvShow
    } else {
        CrawlPageKind::Movie
    }
}

pub fn apache_card_text(chunk: &str) -> String {
    static H2_RE: OnceLock<Regex> = OnceLock::new();
    static TAG_RE: OnceLock<Regex> = OnceLock::new();
    static ATTR_RE: OnceLock<Regex> = OnceLock::new();
    static WS_RE: OnceLock<Regex> = OnceLock::new();

    let h2_re = H2_RE.get_or_init(|| Regex::new(r"(?is)<h2[^>]*>(.*?)</h2>").unwrap());
    let tag_re = TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let attr_re = ATTR_RE
        .get_or_init(|| Regex::new(r#"(?i)\b(?:aria-label|title)=["']([^"']*)["']"#).unwrap());
    let ws_re = WS_RE.get_or_init(|| Regex::new(r"\s+").unwrap());

    if let Some(caps) = h2_re.captures(chunk) {
        let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let no_tags = tag_re.replace_all(inner, " ");
        let decoded = adom_core::decode_entities(&no_tags);
        return ws_re.replace_all(&decoded, " ").trim().to_string();
    }

    let mut decoded_parts = Vec::new();
    for caps in attr_re.captures_iter(chunk) {
        if let Some(m) = caps.get(1) {
            decoded_parts.push(adom_core::decode_entities(m.as_str()));
        }
    }
    let joined = decoded_parts.join(" ");
    ws_re.replace_all(&joined, " ").trim().to_string()
}

pub fn apache_declared_type(text: &str) -> Option<String> {
    static CARD_TYPE_RE: OnceLock<Regex> = OnceLock::new();
    let re = CARD_TYPE_RE
        .get_or_init(|| Regex::new(r"(?i)\(\s*([^()]{2,20}?)\s+de\s+(?:19|20)\d{2}\s*\)").unwrap());

    let mut last_type = None;
    for caps in re.captures_iter(text) {
        if let Some(m) = caps.get(1) {
            last_type = Some(m.as_str().trim().to_string());
        }
    }
    last_type
}

pub fn apache_count_listing_cards(html: &str) -> usize {
    static CAPA_RE: OnceLock<Regex> = OnceLock::new();
    let capa_re =
        CAPA_RE.get_or_init(|| Regex::new(r#"(?i)<div class=["']capa-item["']>"#).unwrap());
    let markup = apache_markup_of(html);
    capa_re.find_iter(&markup).count()
}

pub fn apache_parse_listing_cards(html: &str, base_url: &str) -> Vec<ApacheListingCard> {
    static CAPA_SPLIT_RE: OnceLock<Regex> = OnceLock::new();
    static NON_WORK_TYPE_RE: OnceLock<Regex> = OnceLock::new();
    static A_HREF_RE: OnceLock<Regex> = OnceLock::new();
    static FILME_RE: OnceLock<Regex> = OnceLock::new();
    static SERIE_RE: OnceLock<Regex> = OnceLock::new();

    let capa_re =
        CAPA_SPLIT_RE.get_or_init(|| Regex::new(r#"(?i)<div class=["']capa-item["']>"#).unwrap());
    let non_work_re = NON_WORK_TYPE_RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:M[úu]sicas?|Jogos?|Games?|Programas?|Softwares?|Apps?|Aplicativos?|Livros?|Cursos?)\s*$").unwrap()
    });
    let href_re =
        A_HREF_RE.get_or_init(|| Regex::new(r#"(?i)<a\b[^>]*?\bhref=["']([^"']+)["']"#).unwrap());
    let filme_re = FILME_RE.get_or_init(|| Regex::new(r"(?i)^\s*filme\s*$").unwrap());
    let serie_re = SERIE_RE.get_or_init(|| Regex::new(r"(?i)^\s*s[ée]rie\s*$").unwrap());

    let markup = apache_markup_of(html);
    let mut chunks = capa_re.split(&markup);
    // Descarta o primeiro chunk anterior ao primeiro <div class="capa-item">
    chunks.next();

    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for chunk in chunks {
        let text = apache_card_text(chunk);
        let declared = apache_declared_type(&text);
        if let Some(ref d) = declared {
            if non_work_re.is_match(d) {
                continue;
            }
        }

        for caps in href_re.captures_iter(chunk) {
            let raw_href = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let decoded_href = adom_core::decode_entities(raw_href);
            let resolved = match resolve_url(base_url, &decoded_href) {
                Some(r) => r,
                None => continue,
            };

            if seen.contains(&resolved) {
                continue;
            }
            if !apache_is_work_path(&resolved) {
                continue;
            }
            seen.insert(resolved.clone());

            let kind = if let Some(ref d) = declared {
                if filme_re.is_match(d) {
                    CrawlPageKind::Movie
                } else if serie_re.is_match(d) {
                    CrawlPageKind::TvShow
                } else {
                    apache_kind_from_work_slug(&resolved)
                }
            } else {
                apache_kind_from_work_slug(&resolved)
            };

            out.push(ApacheListingCard {
                url: resolved,
                kind,
            });
        }
    }

    out
}

pub fn apache_page_kind_of(html: &str) -> Option<CrawlPageKind> {
    static LEAD_RE: OnceLock<Regex> = OnceLock::new();
    static LEAD_TYPE_RE: OnceLock<Regex> = OnceLock::new();
    static WORK_TYPE_RE: OnceLock<Regex> = OnceLock::new();
    static FILME_RE: OnceLock<Regex> = OnceLock::new();
    static SERIE_RE: OnceLock<Regex> = OnceLock::new();
    static TAG_RE: OnceLock<Regex> = OnceLock::new();

    let lead_re = LEAD_RE.get_or_init(|| {
        Regex::new(r#"(?is)<p[^>]*class=["'][^"']*item-lead[^"']*["'][^>]*>(.*?)</p>"#).unwrap()
    });
    let lead_type_re = LEAD_TYPE_RE.get_or_init(|| {
        Regex::new(r"(?i)\b(Filme|S[ée]rie|Desenho|Document[áa]rio|Anime)\s+de\s+(?:19|20)\d{2}\b")
            .unwrap()
    });
    let work_type_re = WORK_TYPE_RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:Filme|S[ée]rie|Desenho|Document[áa]rio|Anime)\s*$").unwrap()
    });
    let filme_re = FILME_RE.get_or_init(|| Regex::new(r"(?i)^\s*filme\s*$").unwrap());
    let serie_re = SERIE_RE.get_or_init(|| Regex::new(r"(?i)^\s*s[ée]rie\s*$").unwrap());
    let tag_re = TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());

    let markup = apache_markup_of(html);
    let lead = lead_re
        .captures(&markup)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())?;
    let no_tags = tag_re.replace_all(lead, " ");
    let decoded = adom_core::decode_entities(&no_tags);

    let declared = lead_type_re
        .captures(&decoded)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())?;
    if !work_type_re.is_match(declared) {
        return None;
    }

    if filme_re.is_match(declared) {
        Some(CrawlPageKind::Movie)
    } else if serie_re.is_match(declared) {
        Some(CrawlPageKind::TvShow)
    } else {
        None
    }
}

pub fn apache_parse_imdb_id(html: &str) -> Option<String> {
    extract_single_imdb_id(&apache_markup_of(html))
}

pub fn apache_ficha_of(html: &str) -> String {
    static FICHA_RE: OnceLock<Regex> = OnceLock::new();
    let re = FICHA_RE.get_or_init(|| {
        Regex::new(r#"(?is)<div[^>]*class=["'][^"']*\binfos["'][^>]*>(.*?)</p>"#).unwrap()
    });
    let markup = apache_markup_of(html);
    re.captures(&markup)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .unwrap_or_default()
}

pub fn apache_ficha_original_title(html: &str) -> Option<String> {
    static STRONG_RE: OnceLock<Regex> = OnceLock::new();
    static COLON_RE: OnceLock<Regex> = OnceLock::new();
    static TAG_RE: OnceLock<Regex> = OnceLock::new();
    static WS_RE: OnceLock<Regex> = OnceLock::new();
    static S_SEASON_RE: OnceLock<Regex> = OnceLock::new();

    let strong_re = STRONG_RE.get_or_init(|| Regex::new(r"(?is)<strong>(.*?)</strong>").unwrap());
    let colon_re =
        COLON_RE.get_or_init(|| Regex::new(r"(?i)<strong>\s*[^<]{1,40}?\s*</strong>\s*:").unwrap());
    let tag_re = TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let ws_re = WS_RE.get_or_init(|| Regex::new(r"\s+").unwrap());
    let s_season_re = S_SEASON_RE.get_or_init(|| Regex::new(r"(?i)\s*S\d{1,2}$").unwrap());

    let ficha = apache_ficha_of(html);
    if ficha.is_empty() {
        return None;
    }

    for caps in strong_re.captures_iter(&ficha) {
        let full = caps.get(0).unwrap().as_str();
        if colon_re.is_match(full) {
            continue;
        }
        let inner = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let no_tags = tag_re.replace_all(inner, " ");
        let decoded = adom_core::decode_entities(&no_tags);
        let ws_cleaned = ws_re.replace_all(&decoded, " ").trim().to_string();
        let value = s_season_re.replace(&ws_cleaned, "").trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    None
}

pub fn apache_ficha_size_bytes(html: &str) -> Option<u64> {
    static FICHA_FIELD_RE: OnceLock<Regex> = OnceLock::new();
    static TAMANHO_RE: OnceLock<Regex> = OnceLock::new();
    let field_re = FICHA_FIELD_RE.get_or_init(|| {
        Regex::new(r"(?i)<strong>\s*([^<]{1,40}?)\s*</strong>\s*:\s*([^<]*)").unwrap()
    });
    let tamanho_re = TAMANHO_RE.get_or_init(|| Regex::new(r"(?i)^\s*tamanho\s*$").unwrap());

    let ficha = apache_ficha_of(html);
    for caps in field_re.captures_iter(&ficha) {
        let label = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        if !tamanho_re.is_match(label) {
            continue;
        }
        let val = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if let Some(bytes) = parse_size(val) {
            return Some(bytes);
        }
    }
    None
}
