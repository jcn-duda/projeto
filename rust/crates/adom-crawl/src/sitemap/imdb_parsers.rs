//! Parsing de IMDb IDs de páginas de sites BR.

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;
use url::Url;

/// O sufixo depois de `title/tt…` é de widget de recomendação? (`shared.ts:132`).
pub fn is_imdb_widget_reference(suffix: &str) -> bool {
    static IMDB_WIDGET_PATH_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)/(?:ref_[^/?]*|list|listicle)(?:[/?]|$)").unwrap());
    static IMDB_PLG_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^tt_plg(?:_|$)").unwrap());
    static IMDB_WIDGET_QUERY_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)[?&]ref_=tt_").unwrap());

    if IMDB_WIDGET_PATH_RE.is_match(suffix) || IMDB_WIDGET_QUERY_RE.is_match(suffix) {
        return true;
    }
    let dummy = format!(
        "https://www.imdb.com/title/tt0000000{}",
        suffix.replace("&amp;", "&")
    );
    if let Ok(url) = Url::parse(&dummy) {
        for (key, val) in url.query_pairs() {
            if key.eq_ignore_ascii_case("ref_") && IMDB_PLG_RE.is_match(&val) {
                return true;
            }
        }
    }
    false
}

/// IMDb da obra pelo tt único na página inteira, filtrando widgets de recomendação
/// e comentários HTML (`nerdfilmes`, `comandotorrents`, `redetorrent`, `hdrtorrents`).
pub fn parse_imdb_id(html: &str) -> Option<String> {
    static IMDB_TITLE_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?i)imdb\.com/title/(tt\d{5,})([^"'\s<>]*)"#).unwrap());
    let clean = crate::sitemap::shape_guards::strip_html_comments(html);
    let mut found = HashSet::new();
    for caps in IMDB_TITLE_RE.captures_iter(&clean) {
        let id = caps.get(1).map_or("", |m| m.as_str());
        let suffix = caps.get(2).map_or("", |m| m.as_str());
        if !is_imdb_widget_reference(suffix) {
            found.insert(id.to_string());
        }
    }
    if found.len() == 1 {
        found.into_iter().next()
    } else {
        None
    }
}

/// IMDb da obra pelo âncora da ficha técnica do Vaca (`vaca.ts:114`).
pub fn parse_vaca_imdb_id(html: &str) -> Option<String> {
    static IMDB_ANCHOR_RE: LazyLock<FancyRegex> = LazyLock::new(|| {
        FancyRegex::new(r"(?is)Avalia[^<]{0,16}IMDb.{0,120}?imdb\.com/title/(tt\d{5,})").unwrap()
    });
    let mut found = HashSet::new();
    for cap in IMDB_ANCHOR_RE.captures_iter(html).flatten() {
        if let Some(m) = cap.get(1) {
            found.insert(m.as_str().to_string());
        }
    }
    if found.len() == 1 {
        found.into_iter().next()
    } else {
        None
    }
}

/// IMDb da obra com rótulo "IMDb" dentro da janela de 200 caracteres (`bludv-discovery.ts:272`).
pub fn parse_bludv_imdb_id(html: &str) -> Option<String> {
    static IMDB_ID_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)imdb\.com/title/(tt\d{5,})").unwrap());
    static IMDB_LABEL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)IMDb").unwrap());
    const IMDB_LABEL_WINDOW: usize = 200;

    let mut found = HashSet::new();
    for m in IMDB_ID_RE.find_iter(html) {
        let match_start = m.start();
        let before = &html[..match_start];
        if let Some(last_label) = IMDB_LABEL_RE.find_iter(before).last() {
            if match_start - last_label.start() <= IMDB_LABEL_WINDOW {
                if let Some(cap) = IMDB_ID_RE.captures(m.as_str()) {
                    if let Some(id) = cap.get(1) {
                        found.insert(id.as_str().to_string());
                    }
                }
            }
        }
    }
    if found.len() == 1 {
        found.into_iter().next()
    } else {
        None
    }
}
