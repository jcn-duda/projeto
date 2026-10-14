//! Texto do NerdFilmes (`resolvers/text.ts` + `nerdfilmes-parsers.ts`).
//!
//! Três coisas que são PRÓPRIAS do nerd e por isso ficam fora do núcleo:
//! - `decodeEntitiesBasic` (as formas históricas, sem `&ordf;` etc.);
//! - o `decodeEntities` de `text.ts`, que é o padrão do `stripTags` do nerd. Não
//!   é o `adom_core::decode_entities` (esse tem uma tabela de 50 nomes; o do
//!   `text.ts` tem 15). Trocar mudaria o texto que vai para o título;
//! - a limpeza do título do post (`cleanPostTitle`, variante curta) e os
//!   classificadores de qualidade/fonte, que são de saída própria (R-4).
//!
//! Paridade com o JS: `\b` é ASCII (`(?-u:\b)`, via `compile`), `\d` é `[0-9]`.

use std::sync::LazyLock;

use adom_crawl::resolver_text::strip_tags_with;
use regex::{Captures, Regex};

use crate::common::rules::compile;

// ─── entidades ───────────────────────────────────────────────────────────

static BASIC_AMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&#0?38;|&amp;").expect("entidade &"));
static BASIC_QUOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&quot;").expect("&quot;"));
static BASIC_APOS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&#8217;|&#039;|&apos;").expect("apóstrofo"));
static BASIC_NBSP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&nbsp;").expect("&nbsp;"));

/// `decodeEntitiesBasic` de `text.ts`: as quatro formas históricas do nerd.
pub fn decode_basic(value: &str) -> String {
    let v = BASIC_AMP.replace_all(value, "&").into_owned();
    let v = BASIC_QUOT.replace_all(&v, "\"").into_owned();
    let v = BASIC_APOS.replace_all(&v, "'").into_owned();
    BASIC_NBSP.replace_all(&v, " ").into_owned()
}

static HEX_ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&#x([0-9a-f]+);").expect("hex"));
static DEC_ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&#([0-9]+);").expect("dec"));
static NAMED_ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&([a-z]+);").expect("nomeada"));

/// Ponto de código de `&#x..;`/`&#..;`; sem ponto válido, a entidade fica crua
/// (o `String.fromCodePoint` do JS lança RangeError; ver o relatório).
fn code_point(whole: &str, digits: &str, radix: u32) -> String {
    u32::from_str_radix(digits, radix)
        .ok()
        .and_then(char::from_u32)
        .map_or_else(|| whole.to_string(), |c| c.to_string())
}

/// Tabela `NAMED_ENTITIES` de `text.ts` (15 nomes; `nbsp` é U+0020).
fn named(whole: &str, name: &str) -> String {
    let letter = match name.to_ascii_lowercase().as_str() {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "hellip" => "\u{2026}",
        "ndash" => "\u{2013}",
        "mdash" => "\u{2014}",
        "rsquo" => "\u{2019}",
        "lsquo" => "\u{2018}",
        "ldquo" => "\u{201C}",
        "rdquo" => "\u{201D}",
        "laquo" => "\u{00AB}",
        "raquo" => "\u{00BB}",
        _ => return whole.to_string(),
    };
    letter.to_string()
}

/// `decodeEntities` de `text.ts` (o do `stripTags` do nerd): hex, decimal e
/// nomeadas, nessa ordem, cada passo sobre a saída do anterior.
pub fn decode_rich(value: &str) -> String {
    let hex = HEX_ENTITY.replace_all(value, |c: &Captures| code_point(&c[0], &c[1], 16));
    let dec = DEC_ENTITY.replace_all(&hex, |c: &Captures| code_point(&c[0], &c[1], 10));
    NAMED_ENTITY
        .replace_all(&dec, |c: &Captures| named(&c[0], &c[1]))
        .into_owned()
}

/// `stripTags` de `text.ts` com o decodificador rico (padrão do nerd).
pub fn strip_tags_rich(value: &str) -> String {
    strip_tags_with(value, decode_rich)
}

// ─── atributos ───────────────────────────────────────────────────────────

/// `attribute(tag, name)` do `text.ts`: `\b<name>=` (ou `\s*=\s*`), valor entre
/// aspas simples ou duplas, sem decodificar (quem chama decide).
fn attr_regex(name: &str, allow_ws: bool) -> Regex {
    let eq = if allow_ws { r"\s*=\s*" } else { "=" };
    compile(&format!(r#"(?i){{B}}{name}{eq}["']([^"']*)["']"#))
}

static HREF_ATTR: LazyLock<Regex> = LazyLock::new(|| attr_regex("href", true));
static TITLE_ATTR: LazyLock<Regex> = LazyLock::new(|| attr_regex("title", true));
static CONTENT_ATTR: LazyLock<Regex> = LazyLock::new(|| attr_regex("content", false));

fn captured(re: &Regex, tag: &str) -> Option<String> {
    re.captures(tag).map(|c| c[1].to_string())
}

/// `attribute(tag, 'href', { decode: decodeEntitiesBasic, allowWhitespace: true })`.
pub fn attr_href(tag: &str) -> Option<String> {
    captured(&HREF_ATTR, tag).map(|v| decode_basic(&v))
}

/// `attribute(tag, 'title', { decode: decodeEntitiesBasic, allowWhitespace: true })`.
pub fn attr_title(tag: &str) -> Option<String> {
    captured(&TITLE_ATTR, tag).map(|v| decode_basic(&v))
}

/// `attribute(tag, 'content')`: sem decodificação e sem espaço em volta do `=`.
pub fn attr_content(tag: &str) -> Option<String> {
    captured(&CONTENT_ATTR, tag)
}

// ─── título do post ──────────────────────────────────────────────────────

static TORRENT_WORD: LazyLock<Regex> =
    LazyLock::new(|| compile(r"(?i)\s*Torrent\s*(?:[–-]|&#8211;)?\s*"));
static RESOLUTION_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r"(?i){B}(?:720p|1080p|2160p|4K)(?:\s*/\s*(?:720p|1080p|2160p|4K|5\.1|dual|dublado|legendado))*",
    )
});
static PIXEL_TOKEN: LazyLock<Regex> = LazyLock::new(|| compile(r"(?i){B}[0-9]{3,4}p{B}"));
static AUDIO_PAIR: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r"(?i){B}(?:Dublado|Legendado|Dual\s*Áudio)\s+(?:e|/|&)\s+(?:Dublado|Legendado|Dual\s*Áudio){B}",
    )
});
static AUDIO_WORDS: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r"(?i){B}(?:Dublado|Legendado|Dual\s*Áudio|Download|Online|Grátis|Completo|Completa){B}",
    )
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| compile(r"\s+"));

/// `cleanPostTitle` do nerd (variante curta). Não decodifica entidades: o TS
/// também não, e `&#8211;` sai no título como entra.
pub fn clean_nerd_post_title(title: &str) -> String {
    let s = TORRENT_WORD.replace_all(title, " ").into_owned();
    let s = RESOLUTION_TAIL.replace_all(&s, "").into_owned();
    let s = PIXEL_TOKEN.replace_all(&s, "").into_owned();
    let s = AUDIO_PAIR.replace_all(&s, "").into_owned();
    let s = AUDIO_WORDS.replace_all(&s, "").into_owned();
    SPACES.replace_all(&s, " ").trim().to_string()
}

// ─── qualidade e fonte (classificadores próprios do nerd) ────────────────

/// `NERD_QUALITY_RE`: `\b(\d{3,4})\s*P\b` ou `\b(4K)\b`, sem `i` (o contexto
/// já chega em maiúsculas).
static NERD_QUALITY: LazyLock<Regex> =
    LazyLock::new(|| compile(r"(?:{B}([0-9]{3,4})\s*P{B}|{B}(4K){B})"));
/// `NERD_SOURCE_RE`: sem fronteira, como no TS.
static NERD_SOURCE: LazyLock<Regex> =
    LazyLock::new(|| compile(r"(WEB[-. ]?DL|WEB[-. ]?RIP|BLU[- ]?RAY|HDTV)"));

/// `qualityOf`: o ÚLTIMO marcador do contexto; 4K vale 2160.
pub fn quality_of(context: &str) -> Option<u32> {
    let hit = NERD_QUALITY.captures_iter(context).last()?;
    Some(match hit.get(1) {
        Some(digits) => digits.as_str().parse().ok()?,
        None => 2160,
    })
}

/// `normalizeSource` do nerd: a saída é `BluRay`/`WEB-DL`/`WEBRip`/`HDTV`, não
/// a caixa-alta do núcleo. `WEBRIP` sem separador vira `None` (como no TS).
fn normalize_source(value: &str) -> Option<String> {
    let source = value.to_uppercase().replace(['.', ' '], "-");
    if source.starts_with("BLU") {
        Some("BluRay".into())
    } else if source.starts_with("WEB-DL") {
        Some("WEB-DL".into())
    } else if source.starts_with("WEB-RIP") {
        Some("WEBRip".into())
    } else if source == "HDTV" {
        Some("HDTV".into())
    } else {
        None
    }
}

/// `sourceOf`: o último marcador do contexto, normalizado; sem fallback para
/// marcadores anteriores (o TS não faz).
pub fn source_of(context: &str) -> Option<String> {
    let hit = NERD_SOURCE.captures_iter(context).last()?;
    normalize_source(&hit[1])
}
