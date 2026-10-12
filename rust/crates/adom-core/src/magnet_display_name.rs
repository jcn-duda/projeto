//! Porte de `magnetDisplayName` (`src/utils/title-normalization.ts`).
//!
//! O nome real da release está no `dn=` do magnet. URL de protetor (http ou
//! https) não começa com `magnet:`: não há `dn=` de release, e o nome sai
//! vazio mesmo quando a query repete esse parâmetro.
//!
//! `+` vira espaço antes do decode. Sequência `%` inválida (`%ZZ`, `%`
//! truncado, UTF-8 quebrado) faz `decodeURIComponent` lançar, e a atribuição
//! não acontece: o resultado é o texto já com `+` trocado por espaço, ainda
//! com o `%` ruim. O decode é tudo ou nada — um `%20` anterior ao erro
//! permanece `%20`.

use crate::js_text::js_trim;

/// Nome escondido no `dn=` do primeiro campo preenchido.
///
/// `None` e `""` são falsy, como o `||` do JS. O primeiro campo não vazio
/// vence: `magnet`, depois `magnet_uri`, depois `guid`.
pub fn magnet_display_name(
    magnet: Option<&str>,
    magnet_uri: Option<&str>,
    guid: Option<&str>,
) -> String {
    let raw = truthy(magnet)
        .or_else(|| truthy(magnet_uri))
        .or_else(|| truthy(guid))
        .unwrap_or("");
    // O `trim` só libera o esquema. O `match` do JS corre no texto original.
    if raw.is_empty() || !is_magnet_scheme(js_trim(raw)) {
        return String::new();
    }
    let Some(dn) = extract_dn(raw) else {
        return String::new();
    };
    // '+' é espaço na forma magnet, e isso já vale quando o decode falha.
    let source = dn.replace('+', " ");
    decode_uri_component(&source).unwrap_or(source)
}

/// `""` não conta, como valor falsy no `||` do JS.
fn truthy(v: Option<&str>) -> Option<&str> {
    v.filter(|s| !s.is_empty())
}

/// Prefixo `magnet:` em qualquer caixa, no texto já aparado.
///
/// URL de protetor (http/https) falha aqui e devolve vazio: o link do
/// protetor não carrega o `dn=` da release.
fn is_magnet_scheme(trimmed: &str) -> bool {
    let b = trimmed.as_bytes();
    b.len() >= 7
        && b[0].to_ascii_lowercase() == b'm'
        && b[1].to_ascii_lowercase() == b'a'
        && b[2].to_ascii_lowercase() == b'g'
        && b[3].to_ascii_lowercase() == b'n'
        && b[4].to_ascii_lowercase() == b'e'
        && b[5].to_ascii_lowercase() == b't'
        && b[6] == b':'
}

/// Primeiro `dn=` (qualquer caixa) depois de `?` ou `&`, até o `&` seguinte.
///
/// Valor vazio não casa com `[^&]+`. A busca segue, e um `dn=` posterior
/// ainda pode valer.
fn extract_dn(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i + 4 < bytes.len() {
        if (bytes[i] == b'?' || bytes[i] == b'&')
            && bytes[i + 1].to_ascii_lowercase() == b'd'
            && bytes[i + 2].to_ascii_lowercase() == b'n'
            && bytes[i + 3] == b'='
        {
            let start = i + 4;
            let end = bytes[start..]
                .iter()
                .position(|&b| b == b'&')
                .map(|p| start + p)
                .unwrap_or(bytes.len());
            if end > start {
                return Some(&raw[start..end]);
            }
        }
        i += 1;
    }
    None
}

/// `decodeURIComponent`: cada `%HH` vira um byte UTF-8.
///
/// Escape sem dois dígitos hex, ou bytes que não fecham UTF-8, falha a
/// função inteira (`None`). O buffer parcial é descartado — não se devolve
/// o que já tinha sido decodificado até o `%` ruim.
fn decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'%' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let hi = hex_value(*bytes.get(i + 1)?)?;
        let lo = hex_value(*bytes.get(i + 2)?)?;
        out.push(hi * 16 + lo);
        i += 3;
    }
    String::from_utf8(out).ok()
}

fn hex_value(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
