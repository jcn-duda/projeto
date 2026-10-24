//! Utilitários compartilhados do raspador (parseTitleYear, parseOriginalTitle, magnetHash, stripHtmlComments, isImdbWidgetReference).

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

// O `decode_entities` aqui é o `adom_core::decode_entities` (tabela maior de
// `src/utils/title-normalization.ts`). Autoridade: `crawl-sites/shared.ts:17`
// importa `decodeEntities` de `../../utils/title-normalization.js` — a mesma
// tabela grande. O `br_core::text::decode_entities` (15 nomes) NÃO basta aqui:
// `parseOriginalTitle` precisa de `iacute`→`í` para casar o prefixo
// "Título original:" (medido no teste `test_parse_original_title`).
use adom_core::decode_entities;

/// Sufixos de protetor de link (fonte única para crawl e futuros resolvers BR).
pub mod protector_suffixes;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TitleYear {
    pub title: String,
    pub year: Option<u32>,
}

/// Remove comentários, scripts e estilos do HTML.
pub fn without_noise(html: &str) -> String {
    static RE_COMMENT: OnceLock<Regex> = OnceLock::new();
    static RE_SCRIPT: OnceLock<Regex> = OnceLock::new();
    static RE_STYLE: OnceLock<Regex> = OnceLock::new();

    let re_comment = RE_COMMENT.get_or_init(|| Regex::new(r"(?s)<!--.*?-->").unwrap());
    let re_script =
        RE_SCRIPT.get_or_init(|| Regex::new(r"(?is)<script(?-u:\b)[^>]*>.*?</script>").unwrap());
    let re_style =
        RE_STYLE.get_or_init(|| Regex::new(r"(?is)<style(?-u:\b)[^>]*>.*?</style>").unwrap());

    let s1 = re_comment.replace_all(html, " ");
    let s2 = re_script.replace_all(&s1, " ");
    re_style.replace_all(&s2, " ").into_owned()
}

/// Colapsa múltiplos espaços em branco Unicode em um único espaço ASCII e remove espaços nas pontas.
pub(crate) fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Substitui aspas tipográficas Unicode por ASCII equivalente.
///
/// Evita `.replace().replace().replace()` encadeado (clippy::consecutive_str_replace).
fn normalize_typographic_quotes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\u{2018}' | '\u{2019}' => out.push('\''),
            '\u{201C}' | '\u{201D}' => out.push('"'),
            _ => out.push(ch),
        }
    }
    out
}

/// Comentário HTML fora com a semântica do navegador: `<!--` sem fecho engole o resto do documento.
pub fn strip_html_comments(html: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?s)<!--.*?(?:-->|$)").unwrap());
    re.replace_all(html, " ").into_owned()
}

/// Título e ano do `<h1>` da obra ("Expresso do Amanhã (2013)", "Bancários (2020)").
pub fn parse_title_year(html: &str) -> TitleYear {
    let source = without_noise(html);
    static RE_H1: OnceLock<Regex> = OnceLock::new();
    static RE_TAG: OnceLock<Regex> = OnceLock::new();
    static RE_YEAR: OnceLock<Regex> = OnceLock::new();

    let re_h1 = RE_H1.get_or_init(|| Regex::new(r"(?is)<h1[^>]*>(.*?)</h1>").unwrap());
    let re_tag = RE_TAG.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let re_year = RE_YEAR.get_or_init(|| Regex::new(r"\((\d{4})\)\s*$").unwrap());

    let h1_content = re_h1
        .captures(&source)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or("");
    let stripped = re_tag.replace_all(h1_content, " ");
    let decoded = decode_entities(&stripped);
    // Normaliza aspas tipográficas para ASCII (ex.: &#8217; → ' → ')
    let decoded = normalize_typographic_quotes(&decoded);
    let text = collapse_whitespace(&decoded);

    let (title, year) = if let Some(caps) = re_year.captures(&text) {
        let whole = caps.get(0).unwrap();
        let yr = caps.get(1).unwrap().as_str().parse::<u32>().ok();
        let valid_year = yr.filter(|&y| (1900..=2100).contains(&y));
        let raw_title = &text[..whole.start()];
        (collapse_whitespace(raw_title), valid_year)
    } else {
        (text, None)
    };

    TitleYear { title, year }
}

/// Título ORIGINAL que o post publica sob o `<h1>` ou na ficha técnica.
pub fn parse_original_title(html: &str) -> Option<String> {
    let source = without_noise(html);
    static RE_SPAN: OnceLock<Regex> = OnceLock::new();
    static RE_FICHA: OnceLock<Regex> = OnceLock::new();
    static RE_TAG: OnceLock<Regex> = OnceLock::new();
    static RE_PREFIX: OnceLock<Regex> = OnceLock::new();
    static RE_NEXT_LABEL: OnceLock<Regex> = OnceLock::new();

    let re_span = RE_SPAN.get_or_init(|| {
        Regex::new(r#"(?is)<span[^>]*class="[^"]*(?-u:\bmovie-original\b)[^"]*"[^>]*>(.*?)</span>"#)
            .unwrap()
    });
    let re_ficha = RE_FICHA.get_or_init(|| {
        Regex::new(r#"(?i)T(?:[íi]|&iacute;|&#237;)tulo\s+Original\s*(?:<\/?(?:b|strong|span)(?-u:\b)[^>]*>\s*)*:?\s*(?:<\/?(?:b|strong|span)(?-u:\b)[^>]*>\s*)*([^<"]{1,200})"#).unwrap()
    });
    let re_tag = RE_TAG.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let re_prefix =
        RE_PREFIX.get_or_init(|| Regex::new(r"(?i)^t[íi]tulo\s+original\s*:?\s*").unwrap());
    let re_next_label = RE_NEXT_LABEL.get_or_init(|| {
        Regex::new(r"(?i)\s*(?:IMDb|(?:Ano\s+de\s+)?Lan(?:[çc]|&ccedil;)amento|G[êe]nero|Formato|Qualidade|Idioma|[ÁA]udio|Legenda|Tamanho|Dura[çc][ãa]o|T[íi]tulo\s+Brasileiro|Produtor(?:es|a)?|Diretor(?:es)?|Dire[çc][ãa]o|Elenco|Pa[íi]s)\s*(?:S\d+\s*)?:.*$").unwrap()
    });

    let raw = if let Some(caps) = re_span.captures(&source) {
        caps.get(1).map(|m| m.as_str())
    } else {
        re_ficha
            .captures(&source)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str())
    }?;

    let tag_stripped = re_tag.replace_all(raw, " ");
    let decoded = decode_entities(&tag_stripped);
    let collapsed = collapse_whitespace(&decoded);
    let text = re_prefix.replace(&collapsed, "");
    let text = text.trim();

    if text.contains(" / ") {
        return None;
    }

    let name = re_next_label.replace(text, "");
    let name = name.trim();

    if !name.is_empty() && name.encode_utf16().count() <= 200 {
        Some(name.to_string())
    } else {
        None
    }
}

/// btih do magnet (40 hex ou 32 base32, qualquer caixa). `None` sem hash.
pub fn magnet_hash(magnet: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)xt=urn:btih:([a-z0-9]{32,40})").unwrap());
    re.captures(magnet)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_ascii_lowercase())
}

/// O sufixo depois de `title/tt…` é de widget de recomendação?
pub fn is_imdb_widget_reference(suffix: &str) -> bool {
    static RE_PATH: OnceLock<Regex> = OnceLock::new();
    static RE_VAL: OnceLock<Regex> = OnceLock::new();
    static RE_AMP: OnceLock<Regex> = OnceLock::new();

    let re_path =
        RE_PATH.get_or_init(|| Regex::new(r"(?i)/(?:ref_|list|listicle)(?:[/?]|$)").unwrap());
    let re_val = RE_VAL.get_or_init(|| Regex::new(r"(?i)^tt_plg(?:_|$)").unwrap());
    let re_amp = RE_AMP.get_or_init(|| Regex::new(r"(?i)&amp;").unwrap());

    if re_path.is_match(suffix) {
        return true;
    }

    let cleaned_suffix = re_amp.replace_all(suffix, "&");
    let full_url = format!("https://www.imdb.com/title/tt0000000{cleaned_suffix}");
    if let Ok(parsed) = url::Url::parse(&full_url) {
        for (k, v) in parsed.query_pairs() {
            if k.eq_ignore_ascii_case("ref_") && re_val.is_match(&v) {
                return true;
            }
        }
    }
    false
}

/// `decodeURIComponent(s)`: decodifica todos os `%XX` como UTF-8.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = match *bytes.get(i + 1)? {
                b @ b'0'..=b'9' => b - b'0',
                b @ b'a'..=b'f' => b - b'a' + 10,
                b @ b'A'..=b'F' => b - b'A' + 10,
                _ => return None,
            };
            let lo = match *bytes.get(i + 2)? {
                b @ b'0'..=b'9' => b - b'0',
                b @ b'a'..=b'f' => b - b'a' + 10,
                b @ b'A'..=b'F' => b - b'A' + 10,
                _ => return None,
            };
            out.push(hi * 16 + lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[allow(non_snake_case)]
pub mod compat {
    pub use super::{
        decode_uri_component as decodeUriComponent,
        is_imdb_widget_reference as isImdbWidgetReference, magnet_hash as magnetHash,
        parse_original_title as parseOriginalTitle, parse_title_year as parseTitleYear,
        strip_html_comments as stripHtmlComments,
    };
}
pub use compat::*;

#[cfg(test)]
mod tests;
