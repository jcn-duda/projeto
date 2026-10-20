//! Parsing do payload Stremio do Mico — porte fiel de `cleanTitle` /
//! `magnetOf` / `mapStream` (`src/providers/mico.ts`).
//!
//! As réguas que o Node aplica por regex são reproduzidas à mão (sem crate de
//! regex): título sem os sufixos `👥`/`💾`/`(langs)`/emoji, magnet com os
//! trackers de `sources` NA ORDEM de publicação (Set do JS preserva inserção) e
//! sem `dn=` (o título do Mico é o texto do post, não o nome do torrent).

use std::collections::HashSet;

use adom_core::looks_pt_br;
use serde_json::Value;

use super::pictographic::is_extended_pictographic;
use super::types::MicoRawItem;

const EYES: char = '\u{1F465}'; // 👥
const DISK: char = '\u{1F4BE}'; // 💾
const ELLIPSIS: char = '\u{2026}'; // …

/// Primeira linha sem os sufixos, como `cleanTitle` do `mico.ts`.
pub fn clean_title(first_line: &str) -> String {
    let mut s = first_line.to_string();
    s = cut_from(&s, EYES);
    s = cut_from(&s, DISK);
    s = strip_lang_parens(&s);
    s = strip_truncated_paren(&s);
    s = strip_trailing_ellipsis(&s);
    s = strip_pictographic(&s);
    collapse_ws(&s)
}

/// `replace(/\s*👥.*$/u, '')`: corta na PRIMEIRA ocorrência do emoji.
fn cut_from(text: &str, marker: char) -> String {
    match text.find(marker) {
        Some(index) => text[..index].to_string(),
        None => text.to_string(),
    }
}

/// `\s*\((?:[a-z]+(?:\s*,\s*[a-z]+)*)\)\s*$` (case-insensitive).
fn strip_lang_parens(text: &str) -> String {
    let trimmed = text.trim_end();
    if !trimmed.ends_with(')') {
        return trimmed.to_string();
    }
    let Some(open) = trimmed.rfind('(') else {
        return trimmed.to_string();
    };
    let inner = &trimmed[open + 1..trimmed.len() - 1];
    if !is_lang_list(inner) {
        return trimmed.to_string();
    }
    // O `\s*` antes do `(` também é consumido.
    trimmed[..open].trim_end().to_string()
}

/// `[a-z]+(\s*,\s*[a-z]+)*`: sem espaço nas pontas e cada item só letras.
fn is_lang_list(inner: &str) -> bool {
    if inner.is_empty() || inner.starts_with(char::is_whitespace) {
        return false;
    }
    if inner.ends_with(char::is_whitespace) {
        return false;
    }
    inner.split(',').all(|part| {
        let token = part.trim();
        !token.is_empty() && token.chars().all(|c| c.is_ascii_alphabetic())
    })
}

/// `\s*\([a-z ,]*…\s*$` (case-insensitive) — o Mico corta no meio do sufixo.
fn strip_truncated_paren(text: &str) -> String {
    let trimmed = text.trim_end();
    let Some(prefix) = trimmed.strip_suffix(ELLIPSIS) else {
        return trimmed.to_string();
    };
    let Some(open) = prefix.rfind('(') else {
        return trimmed.to_string();
    };
    let inner = &prefix[open + 1..];
    if !inner
        .chars()
        .all(|c| c.is_ascii_alphabetic() || c == ' ' || c == ',')
    {
        return trimmed.to_string();
    }
    trimmed[..open].trim_end().to_string()
}

/// `…\s*$`: só a elipse final (o `(…` já saiu no passo anterior).
fn strip_trailing_ellipsis(text: &str) -> String {
    let trimmed = text.trim_end();
    match trimmed.strip_suffix(ELLIPSIS) {
        Some(rest) => rest.to_string(),
        None => trimmed.to_string(),
    }
}

/// `\p{Extended_Pictographic}|\u{FE0F}`.
fn strip_pictographic(text: &str) -> String {
    text.chars()
        .filter(|c| *c != '\u{FE0F}' && !is_extended_pictographic(*c))
        .collect()
}

/// `\s+` → espaço + `trim()`. O `\s` do JS também inclui o BOM (U+FEFF), que
/// `split_whitespace` não trata como espaço.
fn collapse_ws(text: &str) -> String {
    text.replace('\u{FEFF}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Magnet com os trackers de `sources`, SEM `dn=`, na ordem do Node.
pub fn magnet_of(hash: &str, sources: Option<&Value>) -> String {
    let mut trackers: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    if let Some(Value::Array(items)) = sources {
        for raw in items {
            let text = js_string_truthy(raw).trim().to_string();
            let url = strip_tracker_prefix(&text);
            if is_tracker_url(url) && seen.insert(url.to_string()) {
                trackers.push(url.to_string());
            }
        }
    }
    let mut magnet = format!("magnet:?xt=urn:btih:{hash}");
    for tracker in trackers {
        magnet.push_str("&tr=");
        magnet.push_str(&encode_uri_component(&tracker));
    }
    magnet
}

/// `String(raw || '')`.
fn js_string_truthy(value: &Value) -> String {
    if !js_truthy(value) {
        return String::new();
    }
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(js_string_truthy)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(true),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `replace(/^tracker:/i, '')` — sem `trim` depois (o Node também não faz).
fn strip_tracker_prefix(url: &str) -> &str {
    match url.get(..8) {
        Some(head) if head.eq_ignore_ascii_case("tracker:") => &url[8..],
        _ => url,
    }
}

/// `^(?:udp|https?|wss?):\/\/[^\s&#]+$` (case-insensitive).
fn is_tracker_url(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    let scheme = scheme.to_ascii_lowercase();
    if !matches!(scheme.as_str(), "udp" | "http" | "https" | "ws" | "wss") {
        return false;
    }
    !rest.is_empty()
        && !rest
            .chars()
            .any(|c| c.is_whitespace() || c == '&' || c == '#')
}

/// `encodeURIComponent`: não escapa `A-Za-z0-9-_.!~*'()`, escapa o resto em
/// UTF-8 percent-encoded com hex MAIÚSCULO.
fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn is_info_hash(text: &str) -> bool {
    text.len() == 40 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `mapStream`: item do payload → cru, ou `None` (hash inválido/título vazio).
pub fn map_stream(raw: &Value) -> Option<MicoRawItem> {
    let info_hash = raw
        .get("infoHash")
        .map(js_string_truthy)
        .unwrap_or_default()
        .trim()
        .to_string();
    if !is_info_hash(&info_hash) {
        return None;
    }
    let full = raw.get("title").map(js_string_truthy).unwrap_or_default();
    let first = full.split('\n').next().unwrap_or("");
    let title = clean_title(first);
    if title.is_empty() {
        return None;
    }
    let seeders = extract_seeders(&full).unwrap_or(1.0);
    let size = extract_size(&full);
    let hash = info_hash.to_ascii_lowercase();
    let is_br = looks_pt_br(&title) || full.to_ascii_lowercase().contains("(brazil");
    Some(MicoRawItem {
        title,
        info_hash: hash.clone(),
        magnet: magnet_of(&hash, raw.get("sources")),
        seeders,
        size,
        indexer: "mico".into(),
        is_br,
    })
}

/// `👥\s*([\d.,]+)`: primeira ocorrência; sem 👥 a fonte não publicou seeders.
fn extract_seeders(full: &str) -> Option<f64> {
    let index = full.find(EYES)?;
    let rest = full[index + EYES.len_utf8()..].trim_start();
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
        .collect();
    if token.is_empty() {
        return None;
    }
    // `Number(group.replace(/[.,]/g, ''))` — ".." vira "" e `Number('')` é 0.
    let cleaned: String = token.chars().filter(|c| *c != '.' && *c != ',').collect();
    if cleaned.is_empty() {
        return Some(0.0);
    }
    let value: f64 = cleaned.parse().ok()?;
    value.is_finite().then_some(value)
}

/// `💾\s*([\d.]+)\s*(TB|GB|MB|KB)` (primeiro match); `None` se ≤ 0/NaN.
fn extract_size(full: &str) -> Option<f64> {
    const UNITS: [(&str, f64); 4] = [
        ("TB", 1_099_511_627_776.0),
        ("GB", 1_073_741_824.0),
        ("MB", 1_048_576.0),
        ("KB", 1_024.0),
    ];
    let mut start = 0;
    while let Some(offset) = full[start..].find(DISK) {
        let at = start + offset;
        let rest = full[at + DISK.len_utf8()..].trim_start();
        let value_len = rest
            .bytes()
            .take_while(|b| b.is_ascii_digit() || *b == b'.')
            .count();
        if value_len > 0 {
            let value_text = &rest[..value_len];
            let after = rest[value_len..].trim_start();
            for (unit, mult) in UNITS {
                let Some(head) = after.get(..unit.len()) else {
                    continue;
                };
                if !head.eq_ignore_ascii_case(unit) {
                    continue;
                }
                // A regex casou: `Math.round(NaN)`/0 vira `0` e o Node para.
                let Ok(value) = value_text.parse::<f64>() else {
                    return None;
                };
                if !value.is_finite() {
                    return None;
                }
                let bytes = (value * mult).round();
                return (bytes > 0.0).then_some(bytes);
            }
        }
        start = at + DISK.len_utf8();
    }
    None
}

#[cfg(test)]
#[path = "parse_tests.rs"]
mod tests;
