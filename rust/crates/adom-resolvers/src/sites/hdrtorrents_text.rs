//! Texto do HDR (`resolvers/text.ts`): entidades, tags e `decodeURIComponent`.
//! A tabela de nomes é a curta do `text.ts`: a do `adom-core` tem nomes que o
//! HDR nunca usou e que mudariam a saída se entrassem aqui.

use std::sync::LazyLock;

use regex::{Captures, Regex};

static ENT_HEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&#x([0-9a-f]+);").expect("hex"));
static ENT_DEC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&#([0-9]+);").expect("dec"));
static ENT_NAMED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&([a-z]+);").expect("nome"));
static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]+>").expect("tags"));

/// Tabela `NAMED_ENTITIES` do `text.ts`.
fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "hellip" => "…",
        "ndash" => "–",
        "mdash" => "—",
        "rsquo" => "’",
        "lsquo" => "‘",
        "ldquo" => "“",
        "rdquo" => "”",
        "laquo" => "«",
        "raquo" => "»",
        _ => return None,
    })
}

/// `replace` com closure que pode falhar (o `String.fromCodePoint` do JS lança).
fn replace_all_fallible(
    re: &Regex,
    text: &str,
    f: impl Fn(&Captures) -> Result<String, String>,
) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for caps in re.captures_iter(text) {
        let whole = caps.get(0).expect("grupo 0");
        out.push_str(&text[last..whole.start()]);
        out.push_str(&f(&caps)?);
        last = whole.end();
    }
    out.push_str(&text[last..]);
    Ok(out)
}

fn code_point(digits: &str, radix: u32) -> Result<String, String> {
    u32::from_str_radix(digits, radix)
        .ok()
        .and_then(char::from_u32)
        .map(String::from)
        .ok_or_else(|| format!("RangeError: code point {digits}"))
}

/// `decodeEntities` do `text.ts`: hex, decimal e nomes, nessa ordem.
pub(super) fn decode_entities_ts(value: &str) -> Result<String, String> {
    let hex = replace_all_fallible(&ENT_HEX, value, |c| code_point(&c[1], 16))?;
    let dec = replace_all_fallible(&ENT_DEC, &hex, |c| code_point(&c[1], 10))?;
    Ok(ENT_NAMED
        .replace_all(&dec, |c: &Captures| {
            named_entity(&c[1].to_lowercase()).map_or_else(|| c[0].to_string(), String::from)
        })
        .into_owned())
}

/// `stripTags(value)` do HDR: tags viram espaço, decodifica, colapsa e apara.
pub(super) fn strip_tags_ts(value: &str) -> Result<String, String> {
    let decoded = decode_entities_ts(&TAGS.replace_all(value, " "))?;
    Ok(decoded
        .split(char::is_whitespace)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" "))
}

/// `decodeURIComponent` do JS: `%XX` precisa de dois hex e a sequência tem que ser UTF-8.
pub(super) fn decode_uri_component(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .filter(|h| h.iter().all(u8::is_ascii_hexdigit))
                .ok_or("URIError: malformed")?;
            let text = std::str::from_utf8(hex).map_err(|_| "URIError: malformed")?;
            out.push(u8::from_str_radix(text, 16).map_err(|_| "URIError: malformed")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "URIError: malformed utf-8".to_string())
}
