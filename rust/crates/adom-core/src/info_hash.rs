//! Porte de `extractInfoHash` e `base32ToHex` (`src/utils/title-normalization.ts`).
//!
//! Aceita o hash em hex (40), em base32 (32) ou o trecho `btih:<hash>` em
//! qualquer ponto do texto, e devolve sempre o hash em hex minúsculo.

use crate::js_text::js_trim;

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn is_hex40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_base32_32(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_alphabetic() || (b'2'..=b'7').contains(&b))
}

/// `base32ToHex`: 32 caracteres base32 viram 40 de hex. `None` quando há um
/// caractere fora do alfabeto (o JS devolve `null`).
pub(crate) fn base32_to_hex(input: &str) -> Option<String> {
    debug_assert_eq!(
        input.len(),
        32,
        "base32ToHex só é chamado com 32 caracteres"
    );
    let upper = input.to_ascii_uppercase();
    let mut bits = String::with_capacity(160);
    for ch in upper.bytes() {
        let idx = BASE32_ALPHABET.iter().position(|&a| a == ch)?;
        bits.push_str(&format!("{idx:05b}"));
    }
    let mut hex = String::with_capacity(40);
    for i in (0..160).step_by(4) {
        let nibble = u8::from_str_radix(&bits[i..i + 4], 2).ok()?;
        hex.push(char::from_digit(u32::from(nibble), 16)?);
    }
    Some(hex)
}

/// Trecho `btih:` seguido de 32 a 40 caracteres alfanuméricos ASCII, sem
/// distinguir caixa (`/btih:([a-zA-Z0-9]{32,40})/i`). Devolve o primeiro.
fn btih_run(text: &str) -> Option<&str> {
    let b = text.as_bytes();
    for start in 0..b.len() {
        let tag = b"btih:";
        if start + tag.len() > b.len() || !b[start..start + tag.len()].eq_ignore_ascii_case(tag) {
            continue;
        }
        let from = start + tag.len();
        let run = b[from..]
            .iter()
            .take_while(|c| c.is_ascii_alphanumeric())
            .count();
        if run >= 32 {
            return Some(&text[from..from + run.min(40)]);
        }
    }
    None
}

/// `extractInfoHash`: hash em hex minúsculo, ou `None`.
pub fn extract_info_hash(input: &str) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    let raw = js_trim(input);
    if is_hex40(raw) {
        return Some(raw.to_ascii_lowercase());
    }
    if is_base32_32(raw) {
        return base32_to_hex(raw);
    }
    let hash = btih_run(raw)?;
    if is_hex40(hash) {
        return Some(hash.to_ascii_lowercase());
    }
    if hash.len() == 32 {
        return base32_to_hex(hash);
    }
    None
}
