//! Porte de `decodeEntities` (`src/utils/title-normalization.ts`).
//!
//! Três passes sobre a string inteira, nesta ordem — o seguinte enxerga o que
//! o anterior inseriu, como os três `replace` do JS:
//! 1. `/&#x([0-9a-f]+);/gi` → `String.fromCodePoint(parseInt(hex, 16))`
//! 2. `/&#(\d+);/g` → `String.fromCodePoint(Number(dec))`
//! 3. `/&([a-z]+);/gi` → tabela em minúsculas

/// Decodifica entidades HTML do título.
///
/// A tabela é consultada em minúsculas. Nome ausente devolve o match inteiro.
/// Letra de `length === 1` cujo nome casa `/^[A-Z]/` herda a caixa
/// (`&Aacute;` → `Á`). `&Amp;` continua `&`: o maiúsculo de `&` é `&`.
pub fn decode_entities(text: &str) -> String {
    let hex = replace_numeric(text, Numeric::Hex);
    let dec = replace_numeric(&hex, Numeric::Dec);
    replace_named(&dec)
}

enum Numeric {
    Hex,
    Dec,
}

/// Valor da tabela `NAMED_ENTITIES`, já em minúsculas.
///
/// `nbsp` é o espaço comum (U+0020) que o fonte TS escreve entre aspas, não
/// U+00A0.
fn named_letter(name: &str) -> Option<&'static str> {
    Some(match name {
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
        "ordf" => "\u{00AA}",
        "ordm" => "\u{00BA}",
        "deg" => "\u{00B0}",
        "aacute" => "\u{00E1}",
        "eacute" => "\u{00E9}",
        "iacute" => "\u{00ED}",
        "oacute" => "\u{00F3}",
        "uacute" => "\u{00FA}",
        "acirc" => "\u{00E2}",
        "ecirc" => "\u{00EA}",
        "ocirc" => "\u{00F4}",
        "atilde" => "\u{00E3}",
        "otilde" => "\u{00F5}",
        "ccedil" => "\u{00E7}",
        "agrave" => "\u{00E0}",
        "uuml" => "\u{00FC}",
        "ntilde" => "\u{00F1}",
        _ => return None,
    })
}

/// `String.fromCodePoint` do JS lança `RangeError` quando o valor não é
/// escalar Unicode (surrogate ou acima de U+10FFFF). Desvio: se o número não
/// cabe em `u32` ou `char::from_u32` falha, a entidade original fica intacta.
/// Sem panic. Esses casos não entram no golden.
fn scalar_from_digits(digits: &str, radix: u32) -> Option<char> {
    let value = u32::from_str_radix(digits, radix).ok()?;
    char::from_u32(value)
}

fn replace_numeric(text: &str, kind: Numeric) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(end) = numeric_end(bytes, i, &kind) {
            let digits = match kind {
                Numeric::Hex => &text[i + 3..end - 1],
                Numeric::Dec => &text[i + 2..end - 1],
            };
            let radix = match kind {
                Numeric::Hex => 16,
                Numeric::Dec => 10,
            };
            if let Some(ch) = scalar_from_digits(digits, radix) {
                out.push(ch);
            } else {
                out.push_str(&text[i..end]);
            }
            i = end;
            continue;
        }
        let ch = next_char(text, i);
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Fim exclusivo de `&#xHEX;` ou `&#DEC;` começando em `i`.
fn numeric_end(bytes: &[u8], i: usize, kind: &Numeric) -> Option<usize> {
    if bytes.get(i) != Some(&b'&') || bytes.get(i + 1) != Some(&b'#') {
        return None;
    }
    let mut j = i + 2;
    if matches!(kind, Numeric::Hex) {
        let marker = *bytes.get(j)?;
        if marker != b'x' && marker != b'X' {
            return None;
        }
        j += 1;
    }
    let start = j;
    while j < bytes.len() && is_digit(bytes[j], kind) {
        j += 1;
    }
    if j == start || bytes.get(j) != Some(&b';') {
        return None;
    }
    Some(j + 1)
}

fn is_digit(byte: u8, kind: &Numeric) -> bool {
    match kind {
        Numeric::Hex => byte.is_ascii_hexdigit(),
        Numeric::Dec => byte.is_ascii_digit(),
    }
}

fn replace_named(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(end) = named_end(bytes, i) {
            let name = &text[i + 1..end - 1];
            if let Some(letra) = named_letter(&name.to_ascii_lowercase()) {
                out.push_str(&apply_case(letra, name));
            } else {
                // Nome fora da tabela: devolve o match inteiro (`&foo;`).
                out.push_str(&text[i..end]);
            }
            i = end;
            continue;
        }
        let ch = next_char(text, i);
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Fim exclusivo de `&nome;` (só letras ASCII) começando em `i`.
fn named_end(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i) != Some(&b'&') {
        return None;
    }
    let mut j = i + 1;
    let start = j;
    while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
        j += 1;
    }
    if j == start || bytes.get(j) != Some(&b';') {
        return None;
    }
    Some(j + 1)
}

/// `letra.length === 1 && /^[A-Z]/.test(name) ? letra.toUpperCase() : letra`.
/// `length` é em unidades UTF-16, como o JS.
fn apply_case(letra: &str, name: &str) -> String {
    let starts_upper = matches!(name.as_bytes().first(), Some(b'A'..=b'Z'));
    if letra.encode_utf16().count() == 1 && starts_upper {
        letra.chars().flat_map(char::to_uppercase).collect()
    } else {
        letra.to_string()
    }
}

fn next_char(text: &str, i: usize) -> char {
    text[i..].chars().next().expect("índice em fronteira UTF-8")
}
