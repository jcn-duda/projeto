//! Evidência textual da Vaca: reparo/decodificação de entidades e temporada do slug.

use std::sync::OnceLock;

use adom_core::decode_entities;

use super::season_or_null;
use crate::shared::decode_uri_component;

/// Repara entidades DESTRUÍDAS antes da decodificação.
///
/// O site/slug solta a entidade sem o "&" ("4ordf" = "4ª") ou mantém só o "#" ("4#170;").
pub fn repair_mangled_entities(value: &str) -> String {
    static RE_ORDF: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static RE_ORDM: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static RE_HASH_A: OnceLock<fancy_regex::Regex> = OnceLock::new();
    static RE_HASH_O: OnceLock<fancy_regex::Regex> = OnceLock::new();

    let re_ordf = RE_ORDF.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*ordf(?![a-z0-9])").unwrap()
    });
    let re_ordm = RE_ORDM.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*ordm(?![a-z0-9])").unwrap()
    });
    let re_hash_a = RE_HASH_A.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*#(?:170|xaa|x00aa)(?![a-z0-9])")
            .unwrap()
    });
    let re_hash_o = RE_HASH_O.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*#(?:186|xba|x00ba)(?![a-z0-9])")
            .unwrap()
    });

    let s1 = re_ordf.replace_all(value, "${1}ª");
    let s2 = re_ordm.replace_all(&s1, "${1}º");
    let s3 = re_hash_a.replace_all(&s2, "${1}ª");
    let s4 = re_hash_o.replace_all(&s3, "${1}º");
    s4.into_owned()
}

/// Decodifica entidades HTML da evidência antes de inferir temporada/agrupar.
///
/// Duas passadas: a primeira repara entidades sem ";" e entidades destruídas.
/// Depois `decode_entities` roda duas vezes para resolver dupla codificação ("&amp;#170;").
pub fn decode_evidence(text: &str) -> String {
    static RE_UNCLOSED: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_unclosed = RE_UNCLOSED.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)&(#[0-9]+|#x[0-9a-f]+|[a-z]{2,8})(?![a-z0-9;])").unwrap()
    });

    let mangled = repair_mangled_entities(text);
    let repaired = re_unclosed.replace_all(&mangled, "&${1};");
    let first = decode_entities(&repaired);
    decode_entities(&first)
}

/// Temporada declarada no slug do card (`seasonFromCardSlug`).
pub fn season_from_card_slug(value: &str) -> Option<i64> {
    let parsed_url = if let Ok(u) = url::Url::parse(value) {
        u
    } else if let Ok(u) = url::Url::parse(&format!(
        "http://localhost/{}",
        value.trim_start_matches('/')
    )) {
        u
    } else {
        return None;
    };

    let decoded_path = decode_uri_component(parsed_url.path())?;
    let path = decode_evidence(&decoded_path).to_lowercase();

    static RE_SEGMENT: OnceLock<regex::Regex> = OnceLock::new();
    let re_segment = RE_SEGMENT.get_or_init(|| regex::Regex::new(r"/season/([^/]+)/?$").unwrap());
    let segment = re_segment
        .captures(&path)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())?;

    static RE_STRAIGHT: OnceLock<regex::Regex> = OnceLock::new();
    let re_straight =
        RE_STRAIGHT.get_or_init(|| regex::Regex::new(r"^temporada-(\d{1,2})$").unwrap());
    if let Some(caps) = re_straight.captures(segment) {
        if let Ok(n) = caps[1].parse::<i64>() {
            return season_or_null(n);
        }
    }

    static RE_ORDINAL: OnceLock<regex::Regex> = OnceLock::new();
    let re_ordinal = RE_ORDINAL.get_or_init(|| {
        regex::Regex::new(r"^(\d{1,2})[-_]*(?:[ªº°]|[ao])?[-_]*temporada$").unwrap()
    });
    if let Some(caps) = re_ordinal.captures(segment) {
        if let Ok(n) = caps[1].parse::<i64>() {
            return season_or_null(n);
        }
    }

    None
}
