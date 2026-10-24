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
    let script_re =
        SCRIPT_RE.get_or_init(|| Regex::new(r"(?is)<script\b[^>]*>.*?</script>").unwrap());
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
    let path_re =
        PATH_RE.get_or_init(|| Regex::new(r"(?i)/(?:ref_|list|listicle)(?:[/?]|$)").unwrap());
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

pub(crate) fn extract_single_imdb_id(cleaned_html: &str) -> Option<String> {
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

pub(crate) fn resolve_url(base_url: &str, href: &str) -> Option<String> {
    if let Ok(base) = url::Url::parse(base_url) {
        base.join(href).ok().map(|u| u.to_string())
    } else if let Ok(parsed) = url::Url::parse(href) {
        Some(parsed.to_string())
    } else {
        None
    }
}

pub(crate) fn extract_pathname(href: &str) -> String {
    if let Ok(parsed) = url::Url::parse(href) {
        parsed.path().to_string()
    } else {
        href.split('?')
            .next()
            .unwrap_or("")
            .split('#')
            .next()
            .unwrap_or("")
            .to_string()
    }
}
