//! Semântica de texto do JS que o Rust não tem de graça: `trim`,
//! `decodeURIComponent` e `encodeURIComponent`. Os portes que dependem delas
//! usam estes helpers em vez de `str::trim` e de crates de percent-encoding,
//! porque as regras diferem em casos de borda que o golden exercita (BOM, escape
//! malformado, reservados).
//!
//! Inclui também a coerção de VALOR do JS (`String()`/`Number()`/`slice` em
//! unidades UTF-16), o `JSON.stringify` compacto e o base64url tolerante do
//! `Buffer` — os três são contrato de paridade byte a byte com o oráculo Node,
//! e é por isso que vivem aqui em vez de `str::trim`/`serde_json::to_string`.
//! Usar `serde_json::Value` nestes helpers exige `serde_json` como dependência
//! de runtime (nota no topo de `config_encoding.rs`).

use serde_json::{Number, Value};

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

/// `String(valor)` do JS para os tipos que aparecem num JSON já parseado
/// (array junta por vírgula, objeto vira `[object Object]`, `null` dentro de
/// array é string vazia).
pub(crate) fn js_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(itens) => itens
            .iter()
            .map(|i| match i {
                Value::Null => String::new(),
                outra => js_to_string(outra),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `Number(x)` do JS sobre um valor JSON (ToPrimitive antes de parsear texto).
pub(crate) fn js_number(v: &Value) -> f64 {
    match v {
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Null => 0.0,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        outra => js_number_of_str(&js_to_string(outra)),
    }
}

/// `Number(str)`: `''`→0, `Infinity`, radixos `0x`/`0b`/`0o`, notação
/// científica. O que o Rust aceitaria e o JS não (`"inf"`, `"nan"`) é barrado
/// pela checagem de alfabeto; `NaN` marca o caminho do fallback.
pub(crate) fn js_number_of_str(raw: &str) -> f64 {
    let trimmed = js_trim(raw);
    if trimmed.is_empty() {
        return 0.0;
    }
    let (sign, body) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1.0f64, rest),
        None => (1.0f64, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    if body.eq_ignore_ascii_case("infinity") {
        return sign * f64::INFINITY;
    }
    let radixos = [("0x", 16u32), ("0X", 16), ("0b", 2), ("0B", 2), ("0o", 8), ("0O", 8)];
    for (prefixo, radix) in radixos {
        if let Some(digitos) = body.strip_prefix(prefixo) {
            return match u64::from_str_radix(digitos, radix) {
                Ok(n) => sign * n as f64,
                Err(_) => f64::NAN,
            };
        }
    }
    if body.is_empty() || !body.bytes().all(|c| c.is_ascii_digit() || b"+-.eE".contains(&c)) {
        return f64::NAN;
    }
    body.parse::<f64>().map(|n| sign * n).unwrap_or(f64::NAN)
}

/// `String(x).slice(0, max_units)` em unidades UTF-16. Um par incompleto não é
/// aberto ao meio (Rust não representa surrogate órfão).
pub(crate) fn js_slice_units(s: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut usados = 0usize;
    for c in s.chars() {
        let peso = if c as u32 > 0xFFFF { 2 } else { 1 };
        if usados + peso > max_units {
            break;
        }
        usados += peso;
        out.push(c);
    }
    out
}

/// `Math.min(max, Math.max(min, Math.trunc(n)))` (NaN/Inf tratados antes).
pub(crate) fn clamp_trunc(n: f64, min: i64, max: i64) -> i64 {
    let t = n.trunc();
    if t <= min as f64 {
        min
    } else if t >= max as f64 {
        max
    } else {
        t as i64
    }
}

/// `JSON.stringify` compacto, com as MESMAS fugas do JS (`\b \f \n \r \t`,
/// `\u00xx` para os outros de controle, restante cru em UTF-8) e a formatação
/// numérica do JS (inteiro exato; exponencial só fora de `1e-6 .. 1e21`).
pub(crate) fn js_stringify(v: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, v);
    out
}

fn write_json(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number_to_string(n)),
        Value::String(s) => write_json_string(out, s),
        Value::Array(itens) => {
            out.push('[');
            for (i, item) in itens.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, val)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, k);
                out.push(':');
                write_json(out, val);
            }
            out.push('}');
        }
    }
}

fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn js_number_to_string(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f == 0.0 {
        return "0".to_string(); // `-0` é "0" no JS
    }
    if !f.is_finite() {
        return "null".to_string(); // `JSON.stringify(Infinity)` devolve `null`
    }
    let abs = f.abs();
    if abs >= 1e21 || abs < 1e-6 {
        // `{:e}` do Rust já é a forma normalizada; o JS só muda o expoente.
        let sci = format!("{f:e}");
        let (mant, exp) = sci.split_once('e').unwrap_or(("0", "0"));
        let e: i64 = exp.parse().unwrap_or(0);
        return format!("{mant}e{}{}", if e < 0 { '-' } else { '+' }, e.abs());
    }
    format!("{f}")
}

// ─── base64url do `Buffer` do Node ────────────────────────────────────

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn alphabet_value(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'-' => Some(62),
        b'_' => Some(63),
        _ => None,
    }
}

/// `Buffer.from(s, 'base64url')`: ignora caractere fora do alfabeto (inclusive o
/// `=`) e DESCARTA o resto de grupo incompleto (1 sobra vira 0 bytes, 2 vira 1,
/// 3 vira 2) — comportamento medido no Node, nao base64url rigido.
pub fn b64url_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        let Some(v) = alphabet_value(c) else { continue };
        acc = ((acc << 6) | u32::from(v)) & 0xFFF;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// `Buffer.from(bytes).toString('base64url')` — alfabeto URL-safe, sem padding.
pub fn b64url_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let byte = |i: usize| u32::from(*chunk.get(i).unwrap_or(&0));
        let n = (byte(0) << 16) | (byte(1) << 8) | byte(2);
        let sextetos = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        // 1 byte -> 2 chars, 2 -> 3, 3 -> 4 (o padding `=` nao existe aqui).
        for &v in sextetos.iter().take(chunk.len() + 1) {
            out.push(ALPHABET[v as usize] as char);
        }
    }
    out
}
