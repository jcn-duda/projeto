use super::*;
use regex::Regex;
use std::sync::OnceLock;

// ─── VacaTorrent Shapes (`vacatorrent-shapes.ts`) ────────────────────────────

/// Filme: página do post → link da página de botões (`/movie-links/<id>/`).
pub fn extract_movie_links(html: &str, base_url: Option<&str>) -> Option<String> {
    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href = RE_HREF
        .get_or_init(|| Regex::new(r#"(?i)href=["']([^"']*\bmovie-links\b[^"']*)["']"#).unwrap());
    static RE_ID: OnceLock<Regex> = OnceLock::new();
    let re_id = RE_ID.get_or_init(|| Regex::new(r"movie-links/(\d+)").unwrap());

    let raw = if let Some(c) = re_href.captures(html) {
        c[1].to_string()
    } else if let Some(c) = re_id.captures(html) {
        format!("/movie-links/{}/", &c[1])
    } else {
        return None;
    };

    if let Some(base) = base_url {
        if let Ok(b) = url::Url::parse(base) {
            if let Ok(joined) = b.join(&raw) {
                return Some(joined.into());
            }
        }
    }
    Some(raw)
}

/// Série: decoding de data-u (base64).
pub fn decode_data_u(html: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"(?i)data-u\s*=\s*["']([^"']+)["']"#).unwrap());
    let caps = re.captures(html)?;
    let bytes = b64_decode(&caps[1]);
    String::from_utf8(bytes).ok().map(|s| s.trim().to_string())
}

/// Série: link interno da página season-internal.
pub fn series_season_internal_url(html: &str, base_url: Option<&str>) -> Option<String> {
    if let Some(decoded) = decode_data_u(html) {
        if decoded.contains("season-internal") {
            if let Some(base) = base_url {
                if let Ok(b) = url::Url::parse(base) {
                    if let Ok(joined) = b.join(&decoded) {
                        return Some(joined.into());
                    }
                }
            }
            return Some(decoded);
        }
    }

    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href = RE_HREF.get_or_init(|| Regex::new(r"(?i)season-internal/\?show=\d+").unwrap());
    if let Some(m) = re_href.find(html) {
        let val = m.as_str();
        if let Some(base) = base_url {
            if let Ok(b) = url::Url::parse(base) {
                if let Ok(joined) = b.join(val) {
                    return Some(joined.into());
                }
            }
        }
        return Some(val.to_string());
    }

    static RE_SHORT: OnceLock<Regex> = OnceLock::new();
    let re_short = RE_SHORT.get_or_init(|| Regex::new(r"(?i)\?p=(\d{4,})").unwrap());
    if let Some(c) = re_short.captures(html) {
        let path = format!("/pt/season-internal/?show={}", &c[1]);
        if let Some(base) = base_url {
            if let Ok(b) = url::Url::parse(base) {
                if let Ok(joined) = b.join(&path) {
                    return Some(joined.into());
                }
            }
        }
        return Some(path);
    }

    None
}

/// Extrai atributo HTML de uma tag.
pub(crate) fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let pattern = format!(r#"(?i)\b{attr}\s*=\s*["']([^"']*)["']"#);
    if let Ok(re) = Regex::new(&pattern) {
        if let Some(c) = re.captures(tag) {
            return Some(c[1].to_string());
        }
    }
    None
}

/// Parseia cards de temporada/batch da página season-internal.
pub fn parse_season_internal(html: &str, base_url: Option<&str>) -> Vec<VacaSeasonCard> {
    static RE_A: OnceLock<Regex> = OnceLock::new();
    let re_a = RE_A.get_or_init(|| Regex::new(r#"(?i)<a\b([^>]*)>([\s\S]*?)</a>"#).unwrap());

    static RE_SEASON_NUM: OnceLock<Regex> = OnceLock::new();
    let re_season_num = RE_SEASON_NUM.get_or_init(|| Regex::new(r"(?i)temporada-(\d+)").unwrap());

    let mut cards = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for cap in re_a.captures_iter(html) {
        let attrs = &cap[1];
        let content = &cap[2];
        let classes = extract_attr(attrs, "class").unwrap_or_default();
        let href = extract_attr(attrs, "href").unwrap_or_default();
        let href = href.trim();
        if href.is_empty() {
            continue;
        }

        let is_batch = classes.contains("sa-card-batch") || href.contains("batch");
        let is_season = classes.contains("sa-card") || href.contains("temporada-");
        if !is_batch && !is_season {
            continue;
        }

        let mut resolved = href.to_string();
        if let Some(base) = base_url {
            if let Ok(b) = url::Url::parse(base) {
                if let Ok(joined) = b.join(href) {
                    resolved = joined.into();
                }
            }
        }

        if !seen.insert(resolved.clone()) {
            continue;
        }

        let season = re_season_num
            .captures(&resolved)
            .and_then(|c| c[1].parse::<u32>().ok())
            .filter(|&s| s > 0);

        cards.push(VacaSeasonCard {
            url: resolved,
            is_batch,
            season,
            title: strip_tags(content),
        });
    }
    cards
}

/// Filtra cards de temporada mantendo batches ou os que casam a temporada solicitada.
pub fn filter_season_cards(
    cards: &[VacaSeasonCard],
    requested_season: Option<u32>,
) -> Vec<VacaSeasonCard> {
    let Some(wanted) = requested_season else {
        return cards.to_vec();
    };
    cards
        .iter()
        .filter(|c| c.season.is_none() || c.season == Some(wanted))
        .cloned()
        .collect()
}

/// Repara entidades destruídas (ex.: "4ordf" -> "4ª", "4ordm" -> "4º").
pub fn repair_mangled_entities(value: &str) -> String {
    static RE_ORDF: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_ordf = RE_ORDF.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*ordf(?![a-z0-9])").unwrap()
    });
    static RE_ORDM: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_ordm = RE_ORDM.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*ordm(?![a-z0-9])").unwrap()
    });

    let s1 = re_ordf.replace_all(value, "${1}ª");
    let s2 = re_ordm.replace_all(&s1, "${1}º");
    s2.into_owned()
}

/// Normaliza o título de um batch: remove prefixo "BATCH – ", repara entidades.
pub fn normalize_batch_title(raw: &str) -> String {
    let repaired = repair_mangled_entities(raw);
    static RE_PREFIX: OnceLock<Regex> = OnceLock::new();
    let re_prefix =
        RE_PREFIX.get_or_init(|| Regex::new(r"(?i)^\s*(?:batch|pack)\b[\s:–—|·-]*\s*").unwrap());
    let stripped = re_prefix.replace(&repaired, "");
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extrai o título real do batch da página (`.bl-hero-title` ou `h1/h2`).
pub fn extract_batch_title(html: &str) -> Option<String> {
    static RE_HERO: OnceLock<Regex> = OnceLock::new();
    let re_hero = RE_HERO.get_or_init(|| {
        Regex::new(r#"(?i)class=["'][^"']*\bbl-hero-title\b[^"']*["'][^>]*>([\s\S]*?)</"#).unwrap()
    });
    if let Some(c) = re_hero.captures(html) {
        return Some(normalize_batch_title(&strip_tags(&c[1])));
    }
    static RE_H: OnceLock<Regex> = OnceLock::new();
    let re_h = RE_H.get_or_init(|| Regex::new(r"(?i)<h[12]\b[^>]*>([\s\S]*?)</h[12]>").unwrap());
    if let Some(c) = re_h.captures(html) {
        return Some(normalize_batch_title(&strip_tags(&c[1])));
    }
    None
}

/// Normaliza blocos `<div class="ss-ep-num">01</div>` para `Episódio 01 `.
pub fn normalize_episode_markup(html: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?i)<(?:span|div)\b[^>]*\bss-ep-num(?:-inline)?\b[^>]*>\s*(\d{1,3})\s*</(?:span|div)>"#).unwrap()
    });
    re.replace_all(html, "Episódio $1 ").into_owned()
}

/// Verifica se âncora é de assistir / player ("Veja Online", `.ss-ep-btn-video`, `.ml-btn-video`).
pub fn is_watch_anchor(attrs: &str, anchor_text: &str) -> bool {
    static RE_CLASS: OnceLock<Regex> = OnceLock::new();
    let re_class = RE_CLASS.get_or_init(|| {
        Regex::new(r#"(?i)\bclass\s*=\s*["'][^"']*\b(?:ss-ep-btn-video|ml-btn-video)\b"#).unwrap()
    });
    static RE_TEXT: OnceLock<Regex> = OnceLock::new();
    let re_text = RE_TEXT.get_or_init(|| Regex::new(r"(?i)veja\s+online").unwrap());

    re_class.is_match(attrs) || re_text.is_match(anchor_text)
}
