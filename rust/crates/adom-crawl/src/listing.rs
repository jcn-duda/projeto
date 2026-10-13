//! Parsers e regras puras da família listing (descobertas paginadas por listagem).
//!
//! Portado de:
//! - `src/providers/crawl-sites/listing-discover.ts`
//! - `src/providers/crawl-sites/hdrtorrents-discovery.ts`
//! - `src/providers/crawl-sites/apachetorrent-discovery.ts`
//! - `resolvers/text.ts` (`parseSize`)

use std::collections::HashSet;
use std::fmt;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

// ── CrawlPageKind ────────────────────────────────────────────────────────────

/// Tipo da página descoberta pelo raspador (filme vs série).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrawlPageKind {
    Movie,
    #[serde(rename = "tv_show")]
    TvShow,
}

impl CrawlPageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::TvShow => "tv_show",
        }
    }

    pub fn from_str_loose(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "movie" | "filme" => Some(Self::Movie),
            "tv_show" | "serie" | "série" | "tvseries" => Some(Self::TvShow),
            _ => None,
        }
    }
}

impl fmt::Display for CrawlPageKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

// ── Extração de Tamanho (parse_size) ─────────────────────────────────────────

/// Reproduz fielmente o `parseSize` de `resolvers/text.ts` e `apachetorrent-discovery.ts`.
///
/// Aceita multiplicadores KB, MB, GB, TB (qualquer caixa), com ponto ou vírgula
/// decimal. Retorna o total exato em bytes arredondado (`Math.round`).
pub fn parse_size(text: &str) -> Option<u64> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)([\d.,]+)\s*(TB|GB|MB|KB)").unwrap());

    let caps = re.captures(text)?;
    let raw_num = caps.get(1)?.as_str();
    let unit = caps.get(2)?.as_str().to_ascii_uppercase();

    // No JS, replace(',', '.') substitui apenas a PRIMEIRA vírgula.
    let num_str = raw_num.replacen(',', ".", 1);
    let val: f64 = num_str.parse().ok()?;
    if !val.is_finite() || val < 0.0 {
        return None;
    }

    let multiplier: f64 = match unit.as_str() {
        "KB" => 1024.0,
        "MB" => 1024.0 * 1024.0,
        "GB" => 1024.0 * 1024.0 * 1024.0,
        "TB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };

    let bytes = (val * multiplier).round();
    if bytes.is_finite() && bytes >= 0.0 && bytes <= (u64::MAX as f64) {
        Some(bytes as u64)
    } else {
        None
    }
}

/// Alias para `parse_size`.
pub fn parse_size_bytes(text: &str) -> Option<u64> {
    parse_size(text)
}

// ── Limpeza de Marcação e Ruído (sem backreference) ──────────────────────────

/// Remove comentários HTML fechados `<!-- ... -->`.
pub fn strip_closed_html_comments(html: &str) -> String {
    static COMMENT_RE: OnceLock<Regex> = OnceLock::new();
    let re = COMMENT_RE.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
    re.replace_all(html, " ").into_owned()
}

/// Remove comentários HTML incluindo abertos até o fim da string `<!-- ... (-->|$)`.
pub fn strip_html_comments(html: &str) -> String {
    static COMMENT_RE: OnceLock<Regex> = OnceLock::new();
    let re = COMMENT_RE.get_or_init(|| Regex::new(r"(?s)<!--.*?(?:-->|$)").unwrap());
    re.replace_all(html, " ").into_owned()
}

/// Limpeza de marcação do ApacheTorrents (`markupOf`).
///
/// REGRA CRÍTICA: Reescreve o regex com backreference `/<(script|style)...<\/\1>/`
/// em duas passagens limpas sem backreference (`<script>` e `<style>`).
pub fn apache_markup_of(html: &str) -> String {
    static COMMENT_RE: OnceLock<Regex> = OnceLock::new();
    static SCRIPT_RE: OnceLock<Regex> = OnceLock::new();
    static STYLE_RE: OnceLock<Regex> = OnceLock::new();

    let comment_re = COMMENT_RE.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
    let script_re = SCRIPT_RE.get_or_init(|| Regex::new(r"(?is)<script\b[^>]*>.*?</script>").unwrap());
    let style_re = STYLE_RE.get_or_init(|| Regex::new(r"(?is)<style\b[^>]*>.*?</style>").unwrap());

    let s1 = comment_re.replace_all(html, " ");
    let s2 = script_re.replace_all(&s1, " ");
    style_re.replace_all(&s2, " ").into_owned()
}

// ── IMDb e Widget References ─────────────────────────────────────────────────

/// Verifica se o sufixo de uma URL do IMDb aponta para widget de recomendação/plugin.
pub fn is_imdb_widget_reference(suffix: &str) -> bool {
    static PATH_RE: OnceLock<Regex> = OnceLock::new();
    static PLG_RE: OnceLock<Regex> = OnceLock::new();
    let path_re = PATH_RE.get_or_init(|| Regex::new(r"(?i)/(?:ref_|list|listicle)(?:[/?]|$)").unwrap());
    let plg_re = PLG_RE.get_or_init(|| Regex::new(r"(?i)^tt_plg(?:_|$)").unwrap());

    if path_re.is_match(suffix) {
        return true;
    }

    let normalized_suffix = suffix.replace("&amp;", "&").replace("&AMP;", "&");
    let test_url = format!("https://www.imdb.com/title/tt0000000{}", normalized_suffix);
    if let Ok(parsed) = url::Url::parse(&test_url) {
        for (k, v) in parsed.query_pairs() {
            if k.eq_ignore_ascii_case("ref_") && plg_re.is_match(&v) {
                return true;
            }
        }
    }
    false
}

fn extract_single_imdb_id(cleaned_html: &str) -> Option<String> {
    static IMDB_TITLE_RE: OnceLock<Regex> = OnceLock::new();
    let re = IMDB_TITLE_RE.get_or_init(|| {
        Regex::new(r#"(?i)(?:https?:)?//(?:www\.|m\.)?imdb\.com/(?:[a-z]{2}/)?title/(tt\d{5,})([^"'\s<>]*)"#).unwrap()
    });

    let mut found = HashSet::new();
    for caps in re.captures_iter(cleaned_html) {
        let tt = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let suffix = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if !is_imdb_widget_reference(suffix) {
            found.insert(tt.to_string());
        }
    }

    if found.len() == 1 {
        found.into_iter().next()
    } else {
        None
    }
}

// ── Resolução de URL ─────────────────────────────────────────────────────────

fn resolve_url(base_url: &str, href: &str) -> Option<String> {
    if let Ok(base) = url::Url::parse(base_url) {
        base.join(href).ok().map(|u| u.to_string())
    } else if let Ok(parsed) = url::Url::parse(href) {
        Some(parsed.to_string())
    } else {
        None
    }
}

fn extract_pathname(href: &str) -> String {
    if let Ok(parsed) = url::Url::parse(href) {
        parsed.path().to_string()
    } else {
        href.split('?').next().unwrap_or("").split('#').next().unwrap_or("").to_string()
    }
}

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
    let attr_re = ATTR_RE.get_or_init(|| Regex::new(r#"(?i)\b(?:aria-label|title)=["']([^"']*)["']"#).unwrap());
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
    let re = CARD_TYPE_RE.get_or_init(|| {
        Regex::new(r"(?i)\(\s*([^()]{2,20}?)\s+de\s+(?:19|20)\d{2}\s*\)").unwrap()
    });

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
    let capa_re = CAPA_RE.get_or_init(|| Regex::new(r#"(?i)<div class=["']capa-item["']>"#).unwrap());
    let markup = apache_markup_of(html);
    capa_re.find_iter(&markup).count()
}

pub fn apache_parse_listing_cards(html: &str, base_url: &str) -> Vec<ApacheListingCard> {
    static CAPA_SPLIT_RE: OnceLock<Regex> = OnceLock::new();
    static NON_WORK_TYPE_RE: OnceLock<Regex> = OnceLock::new();
    static A_HREF_RE: OnceLock<Regex> = OnceLock::new();
    static FILME_RE: OnceLock<Regex> = OnceLock::new();
    static SERIE_RE: OnceLock<Regex> = OnceLock::new();

    let capa_re = CAPA_SPLIT_RE.get_or_init(|| Regex::new(r#"(?i)<div class=["']capa-item["']>"#).unwrap());
    let non_work_re = NON_WORK_TYPE_RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:M[úu]sicas?|Jogos?|Games?|Programas?|Softwares?|Apps?|Aplicativos?|Livros?|Cursos?)\s*$").unwrap()
    });
    let href_re = A_HREF_RE.get_or_init(|| Regex::new(r#"(?i)<a\b[^>]*?\bhref=["']([^"']+)["']"#).unwrap());
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
        Regex::new(r"(?i)\b(Filme|S[ée]rie|Desenho|Document[áa]rio|Anime)\s+de\s+(?:19|20)\d{2}\b").unwrap()
    });
    let work_type_re = WORK_TYPE_RE.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:Filme|S[ée]rie|Desenho|Document[áa]rio|Anime)\s*$").unwrap()
    });
    let filme_re = FILME_RE.get_or_init(|| Regex::new(r"(?i)^\s*filme\s*$").unwrap());
    let serie_re = SERIE_RE.get_or_init(|| Regex::new(r"(?i)^\s*s[ée]rie\s*$").unwrap());
    let tag_re = TAG_RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());

    let markup = apache_markup_of(html);
    let lead = lead_re.captures(&markup).and_then(|c| c.get(1)).map(|m| m.as_str())?;
    let no_tags = tag_re.replace_all(lead, " ");
    let decoded = adom_core::decode_entities(&no_tags);

    let declared = lead_type_re.captures(&decoded).and_then(|c| c.get(1)).map(|m| m.as_str())?;
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
    let colon_re = COLON_RE.get_or_init(|| Regex::new(r"(?i)<strong>\s*[^<]{1,40}?\s*</strong>\s*:").unwrap());
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
        Regex::new(r#"(?i)<main\b[^>]*\bitemtype=["']https?://schema\.org/(Movie|TVSeries)["'][^>]*>"#).unwrap()
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
        (false, Some(CrawlPageKind::TvShow)) => Some("serie_com_kind_movie: a ficha declara TVSeries"),
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
        Regex::new(r#"(?is)<a\b[^>]*?\bclass=["'][^"']*media-card-link[^"']*["'][^>]*>(.*?)</a>"#).unwrap()
    });
    let href_re = HREF_RE.get_or_init(|| Regex::new(r#"(?i)\bhref=["']([^"']+)["']"#).unwrap());
    let title_re = TITLE_RE.get_or_init(|| {
        Regex::new(r#"(?is)class=["'][^"']*media-card-title[^"']*["'][^>]*>(.*?)(?:</h3>|</article>|$)"#).unwrap()
    });
    let year_re = YEAR_RE.get_or_init(|| {
        Regex::new(r#"(?i)class=["'][^"']*media-card-year[^"']*["'][^>]*>\s*\(?(\d{4})\)?"#).unwrap()
    });
    let type_re = TYPE_RE.get_or_init(|| {
        Regex::new(r#"(?i)class=["'][^"']*badge-tipo[^"']*["'][^>]*>(.*?)</(?:span|div|a)>"#).unwrap()
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

        let raw_title = title_re.captures(inner).and_then(|c| c.get(1)).map(|m| m.as_str()).unwrap_or("");
        let title_no_tags = tag_re.replace_all(raw_title, " ");
        let title = adom_core::decode_entities(&title_no_tags).trim().to_string();

        let year: Option<u32> = year_re.captures(inner)
            .and_then(|c| c.get(1))
            .and_then(|m| m.as_str().parse().ok());

        let card_type = type_re.captures(inner)
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

// ── Lógica Pura de Paginação (`listing-discover.ts`) ──────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingPost {
    pub url: String,
    pub kind: Option<CrawlPageKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingPageRead {
    pub posts: Vec<ListingPost>,
    pub card_count: Option<usize>,
    pub recognized_count: Option<usize>,
}

/// Trava primária de fim de catálogo por contagem.
pub fn is_listing_end(raw_cards: usize, accepted_posts: usize, expected_full_page: usize) -> bool {
    raw_cards.max(accepted_posts) < expected_full_page
}

/// Detecção de inversão / página repetida sem posts inéditos.
pub fn is_repeated_page(fresh_count: usize, end_of_listing: bool) -> bool {
    fresh_count == 0 && !end_of_listing
}

/// Valida se a página possui cards reconhecidos e no host permitido.
pub fn check_listing_recognition(
    raw_cards: usize,
    recognized_cards: usize,
    accepted_keys: usize,
) -> Result<(), &'static str> {
    if recognized_cards == 0 || accepted_keys == 0 {
        if accepted_keys == 0 && recognized_cards > 0 {
            Err("nenhuma-obra-no-host")
        } else if raw_cards > 0 {
            Err("cards-nao-reconhecidos")
        } else {
            Err("nenhum-card")
        }
    } else {
        Ok(())
    }
}

// ── Aliases convencionais ───────────────────────────────────────────────────

pub use apache_parse_listing_cards as parse_listing_cards;
pub use apache_count_listing_cards as count_listing_cards;
pub use apache_page_kind_of as page_kind_of;

#[cfg(test)]
mod tests {
    use super::*;

    // ── Testes de parse_size ─────────────────────────────────────────────────

    #[test]
    fn test_parse_size_exact_multipliers() {
        assert_eq!(parse_size("52.4 GB"), Some(56264071578));
        assert_eq!(parse_size("2,45 GB"), Some(2630667469));
        assert_eq!(parse_size("2,8 gb"), Some(3006477107));
        assert_eq!(parse_size("950 MB"), Some(996147200));
        assert_eq!(parse_size("950 mb"), Some(996147200));
        assert_eq!(parse_size("0.8 TB"), Some(879609302221));
        assert_eq!(parse_size("1,5 Tb"), Some(1649267441664));
        assert_eq!(parse_size("500 KB"), Some(512000));
        assert_eq!(parse_size("500 kb"), Some(512000));
        assert_eq!(parse_size("1 KB"), Some(1024));
        assert_eq!(parse_size("1.78 GB"), Some(1911260447));
        assert_eq!(parse_size("invalido"), None);
        assert_eq!(parse_size(""), None);
    }

    // ── Testes de Regra 1: markup_of sem backreference ───────────────────────

    #[test]
    fn test_markup_of_without_backreference() {
        let input = "<div><!-- comentario fechado --><script type=\"text/javascript\">alert('oi');</script><span>teste</span><style>.cor { color: red; }</style></div>";
        let cleaned = apache_markup_of(input);
        assert!(!cleaned.contains("alert"));
        assert!(!cleaned.contains("color: red"));
        assert!(!cleaned.contains("comentario fechado"));
        assert!(cleaned.contains("teste"));
    }

    // ── Testes com Fixtures Reais do ApacheTorrents ─────────────────────────

    const APACHE_PAGE1: &str = include_str!("../../../../test/fixtures/crawl/apachetorrent/pagina-1-cheia.html");
    const APACHE_PAGE_END: &str = include_str!("../../../../test/fixtures/crawl/apachetorrent/pagina-fim-calcanhar.html");
    const APACHE_POST_FILME: &str = include_str!("../../../../test/fixtures/crawl/apachetorrent/post-filme.html");
    const APACHE_POST_SERIE: &str = include_str!("../../../../test/fixtures/crawl/apachetorrent/post-serie.html");
    const APACHE_POST_DESENHO: &str = include_str!("../../../../test/fixtures/crawl/apachetorrent/post-serie-desenho.html");

    #[test]
    fn test_apache_listing_page_real_fixture() {
        assert_eq!(apache_count_listing_cards(APACHE_PAGE1), 20);
        let cards = apache_parse_listing_cards(APACHE_PAGE1, "https://apachetorrents.com/");
        assert_eq!(cards.len(), 20, "20 obras unicas apos deduplicacao de capa e titulo");

        let movies: Vec<_> = cards.iter().filter(|c| c.kind == CrawlPageKind::Movie).collect();
        let series: Vec<_> = cards.iter().filter(|c| c.kind == CrawlPageKind::TvShow).collect();
        assert_eq!(movies.len(), 11, "11 filmes na pagina 1");
        assert_eq!(series.len(), 9, "9 series na pagina 1");

        // Futurama e Presidente Curtis sao desenhos com temporada no slug -> tv_show
        assert!(series.iter().any(|c| c.url.contains("futurama-14a-temporada")));
        assert!(series.iter().any(|c| c.url.contains("presidente-curtis-1a-temporada")));

        // Pagina fim calcanhar tem 15 cards
        assert_eq!(apache_count_listing_cards(APACHE_PAGE_END), 15);
        let end_cards = apache_parse_listing_cards(APACHE_PAGE_END, "https://apachetorrents.com/");
        assert_eq!(end_cards.len(), 15);
    }

    #[test]
    fn test_apache_posts_real_fixtures() {
        // post-filme.html
        assert_eq!(apache_page_kind_of(APACHE_POST_FILME), Some(CrawlPageKind::Movie));
        assert_eq!(apache_parse_imdb_id(APACHE_POST_FILME), Some("tt5125894".to_string()));
        assert_eq!(apache_ficha_original_title(APACHE_POST_FILME), Some("Poms".to_string()));
        assert_eq!(apache_ficha_size_bytes(APACHE_POST_FILME), Some(1911260447)); // 1.78 GB

        // post-serie.html
        assert_eq!(apache_page_kind_of(APACHE_POST_SERIE), Some(CrawlPageKind::TvShow));
        assert_eq!(apache_ficha_original_title(APACHE_POST_SERIE), Some("Lanterns".to_string()));

        // post-serie-desenho.html (Desenho e ambiguo no item-lead -> None)
        assert_eq!(apache_page_kind_of(APACHE_POST_DESENHO), None);
        assert_eq!(apache_parse_imdb_id(APACHE_POST_DESENHO), Some("tt37692332".to_string()));
        assert_eq!(apache_ficha_original_title(APACHE_POST_DESENHO), Some("President Curtis".to_string()));
    }

    // ── Testes com Fixtures Reais do HDRTorrents ────────────────────────────

    const HDR_PAGE1: &str = include_str!("../../../../test/fixtures/crawl/hdrtorrents/pagina-1-cheia.html");
    const HDR_PAGE_END: &str = include_str!("../../../../test/fixtures/crawl/hdrtorrents/pagina-fim-calcanhar.html");
    const HDR_POST_FILME: &str = include_str!("../../../../test/fixtures/crawl/hdrtorrents/post-filme.html");
    const HDR_POST_SERIE: &str = include_str!("../../../../test/fixtures/crawl/hdrtorrents/post-serie.html");

    #[test]
    fn test_hdr_listing_page_real_fixture() {
        assert_eq!(hdr_count_listing_cards(HDR_PAGE1), 20);
        assert_eq!(hdr_count_listing_cards(HDR_PAGE_END), 15);

        let cards = hdr_parse_listing_cards(HDR_PAGE1, "https://hdrtorrents.net/");
        assert_eq!(cards.len(), 20);

        let movies: Vec<_> = cards.iter().filter(|c| c.kind == CrawlPageKind::Movie).collect();
        let series: Vec<_> = cards.iter().filter(|c| c.kind == CrawlPageKind::TvShow).collect();
        assert_eq!(movies.len(), 11);
        assert_eq!(series.len(), 9);

        assert_eq!(cards[0].url, "https://hdrtorrents.net/futurama-14a-temporada-torrent-download/");
        assert_eq!(cards[0].kind, CrawlPageKind::TvShow);
    }

    const HDR_POST_SERIE_AGREGADA: &str = include_str!("../../../../test/fixtures/crawl/hdrtorrents/post-serie-agregada.html");

    #[test]
    fn test_hdr_posts_real_fixtures() {
        // post-filme.html (snippet sem <main> retorna None)
        assert_eq!(hdr_page_kind_of(HDR_POST_FILME), None);
        assert_eq!(hdr_declares_series(HDR_POST_FILME), false);
        assert_eq!(hdr_parse_imdb_id(HDR_POST_FILME), Some("tt1197624".to_string()));

        // post-serie.html (snippet sem <main> retorna None)
        assert_eq!(hdr_page_kind_of(HDR_POST_SERIE), None);
        assert_eq!(hdr_parse_imdb_id(HDR_POST_SERIE), Some("tt10893694".to_string()));

        // post-serie-agregada.html traz <main class="container my-3" itemscope itemtype="https://schema.org/TVSeries">
        assert_eq!(hdr_page_kind_of(HDR_POST_SERIE_AGREGADA), Some(CrawlPageKind::TvShow));
        assert_eq!(hdr_declares_series(HDR_POST_SERIE_AGREGADA), true);

        // Sintético com Movie
        let synthetic_movie = r#"<main class="container my-3" itemscope itemtype="https://schema.org/Movie"><h1>Filme</h1></main>"#;
        assert_eq!(hdr_page_kind_of(synthetic_movie), Some(CrawlPageKind::Movie));
        assert_eq!(hdr_declares_series(synthetic_movie), false);
    }

    // ── Testes de Detecção de IMDb e Widgets ────────────────────────────────

    #[test]
    fn test_imdb_widget_filtration() {
        let widget = r#"<a href="https://www.imdb.com/title/tt1959490/?ref_=tt_plg_rt">7.0</a>"#;
        assert_eq!(extract_single_imdb_id(widget), None);

        let with_valid = format!(r#"{}<a href="https://www.imdb.com/title/tt0340163/">IMDb</a>"#, widget);
        assert_eq!(extract_single_imdb_id(&with_valid), Some("tt0340163".to_string()));

        let ambiguous = r#"<a href="https://www.imdb.com/title/tt0340163/">IMDb</a><a href="https://www.imdb.com/title/tt1234567/">IMDb</a>"#;
        assert_eq!(extract_single_imdb_id(ambiguous), None);

        let commented = r#"<!-- <a href="https://www.imdb.com/title/tt1959490/">widget</a> -->"#;
        assert_eq!(apache_parse_imdb_id(commented), None);

        let fake_domain = r#"<a href="https://notimdb.com/title/tt1234567/">falso domínio</a>"#;
        assert_eq!(extract_single_imdb_id(fake_domain), None);

        assert_eq!(extract_single_imdb_id(r#"<a href="https://www.imdb.com/title/tt0340163/listend">IMDb</a>"#), Some("tt0340163".to_string()));
        assert_eq!(extract_single_imdb_id(r#"<a href="https://m.imdb.com/title/tt0340163/">IMDb</a>"#), Some("tt0340163".to_string()));
        assert_eq!(extract_single_imdb_id(r#"<a href="https://www.imdb.com/title/tt1234567/?ref_=tt_review">obra</a>"#), Some("tt1234567".to_string()));
    }

    // ── Testes de Paginação e Reconhecimento ─────────────────────────────────

    #[test]
    fn test_pagination_rules() {
        assert!(is_listing_end(15, 15, 20));
        assert!(!is_listing_end(20, 20, 20));
        assert!(!is_listing_end(19, 20, 20));

        assert!(is_repeated_page(0, false));
        assert!(!is_repeated_page(0, true));
        assert!(!is_repeated_page(5, false));

        assert_eq!(check_listing_recognition(20, 20, 20), Ok(()));
        assert_eq!(check_listing_recognition(20, 20, 0), Err("nenhuma-obra-no-host"));
        assert_eq!(check_listing_recognition(20, 0, 0), Err("cards-nao-reconhecidos"));
        assert_eq!(check_listing_recognition(0, 0, 0), Err("nenhum-card"));
    }

    // ── Testes de Slugs de Obra e Temporada ──────────────────────────────────

    #[test]
    fn test_slug_rules() {
        assert!(apache_is_work_path("/filme-exemplo-baixar-torrent/"));
        assert!(!apache_is_work_path("/pagina/2/"));
        assert!(!apache_is_work_path("/filmes/"));

        assert!(hdr_is_work_path("/filme-exemplo-torrent-download/"));
        assert!(!hdr_is_work_path("/pagina/2/"));
        assert!(!hdr_is_work_path("/desenhos/"));

        assert!(apache_is_season_slug("serie-1a-temporada-baixar-torrent"));
        assert!(apache_is_season_slug("serie-14a-temporada-baixar-torrent"));
        assert!(apache_is_season_slug("serie-3-temporada-baixar-torrent"));
        assert!(!apache_is_season_slug("filme-comum-baixar-torrent"));

        assert_eq!(apache_kind_from_work_slug("serie-1a-temporada-baixar-torrent"), CrawlPageKind::TvShow);
        assert_eq!(apache_kind_from_work_slug("filme-comum-baixar-torrent"), CrawlPageKind::Movie);
    }
}
