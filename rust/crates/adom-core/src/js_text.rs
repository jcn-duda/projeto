//! Semântica de texto do JS que o Rust não tem de graça: `trim`,
//! `decodeURIComponent` e `encodeURIComponent`. Os portes que dependem delas
//! usam estes helpers em vez de `str::trim` e de crates de percent-encoding,
//! porque as regras diferem em casos de borda que o golden exercita (BOM, escape
//! malformado, reservados).

/// Caractere de espaço no sentido do `String.prototype.trim` do JS:
/// WhiteSpace (incluindo U+FEFF, o BOM) e LineTerminator.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `s.trim()` do JS.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `decodeURIComponent(s)`: decodifica todos os `%XX` como UTF-8. `None` quando
/// o JS lançaria `URIError` (escape sem dois dígitos hex, ou bytes que não
/// formam UTF-8 válido).
pub(crate) fn js_decode_uri_component(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = hex_value(*bytes.get(i + 1)?)?;
            let lo = hex_value(*bytes.get(i + 2)?)?;
            out.push(hi * 16 + lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
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

/// `encodeURIComponent` de um caractere: mantém `A-Za-z0-9 - _ . ! ~ * ' ( )`
/// e percent-encoda o resto em UTF-8, com hex maiúsculo.
pub(crate) fn js_encode_char(c: char) -> String {
    let mut buf = [0u8; 4];
    let mut out = String::new();
    if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
        out.push(c);
        return out;
    }
    for b in c.encode_utf8(&mut buf).bytes() {
        out.push_str(&format!("%{b:02X}"));
    }
    out
}

/// `encodeURIComponent(s)`.
pub(crate) fn js_encode_uri_component(s: &str) -> String {
    s.chars().map(js_encode_char).collect()
}

/// `safeDecode` de magnet-uri.ts: decodifica, ou devolve o próprio texto se o
/// decode falhar.
pub(crate) fn safe_decode(s: &str) -> String {
    js_decode_uri_component(s).unwrap_or_else(|| s.to_string())
}
