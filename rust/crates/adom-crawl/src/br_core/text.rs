//! Texto dos profiles (`resolvers/text.ts`): o `decodeEntities` que TODOS os
//! profiles usam (cleanPostTitle, stripTags do site-profile, decodeHtml) tem 15
//! nomes. NÃO é o `adom_core::decode_entities`, que é o de
//! `src/utils/title-normalization.ts` (tabela maior): com ele "1&ordf;
//! Temporada" virava "1ª" no Rust e ficava cru no TS.

use std::sync::LazyLock;

use crate::resolver_text::strip_tags_with;
use regex::{Captures, Regex};

static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&#x([0-9a-f]+);").expect("hex"));
static DEC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&#([0-9]+);").expect("dec"));
static NAMED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&([a-z]+);").expect("nomeada"));

/// Ponto de código de `&#x..;`/`&#..;`. Sem ponto válido a entidade fica crua
/// (o `String.fromCodePoint` do JS lança `RangeError` — caso que os sites não
/// publicam).
fn code_point(whole: &str, digits: &str, radix: u32) -> String {
    u32::from_str_radix(digits, radix)
        .ok()
        .and_then(char::from_u32)
        .map_or_else(|| whole.to_string(), |c| c.to_string())
}

/// `NAMED_ENTITIES` de `text.ts` (`nbsp` vira espaço comum, U+0020).
fn named(whole: &str, name: &str) -> String {
    let text = match name.to_ascii_lowercase().as_str() {
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
    text.to_string()
}

/// `decodeEntities` de `text.ts`: hex, decimal e nomeadas, nessa ordem, cada
/// passo sobre a saída do anterior.
pub fn decode_entities(value: &str) -> String {
    let hex = HEX.replace_all(value, |c: &Captures| code_point(&c[0], &c[1], 16));
    let dec = DEC.replace_all(&hex, |c: &Captures| code_point(&c[0], &c[1], 10));
    NAMED
        .replace_all(&dec, |c: &Captures| named(&c[0], &c[1]))
        .into_owned()
}

/// `stripTags(value)` de `text.ts` com o `decodeEntities` padrão.
pub fn strip_tags(value: &str) -> String {
    strip_tags_with(value, decode_entities)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tabela_pequena_do_text_ts() {
        assert_eq!(decode_entities("1&ordf; Temporada"), "1&ordf; Temporada");
        assert_eq!(
            decode_entities("A &amp; B &#8211; C &#x2014; D&nbsp;E"),
            "A & B – C — D E"
        );
        // Sequencial: o `&amp;` decodificado no fim não reabre `&#39;`.
        assert_eq!(decode_entities("&amp;#39;"), "&#39;");
        assert_eq!(strip_tags("<b>Oi</b>&hellip;"), "Oi …");
    }
}
