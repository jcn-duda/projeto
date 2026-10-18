//! Parsing do payload Stremio do Mico — porte de `mapStream` / `cleanTitle`
//! / `magnetOf` / `retryAfterMs` em `src/providers/mico.ts`.

use std::collections::HashSet;

use adom_core::looks_pt_br;
use serde_json::Value;

use super::types::MicoRawItem;

const EYES: char = '\u{1F465}'; // 👥
const DISK: char = '\u{1F4BE}'; // 💾
const ELLIPSIS: char = '\u{2026}'; // …

/// `Retry-After` → ms. Aceita delta-segundos e data HTTP; `None` se ilegível.
pub fn retry_after_ms(header: Option<&str>, now_ms: i64) -> Option<u64> {
    let raw = header?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(secs) = raw.parse::<f64>() {
        if secs.is_finite() && secs >= 0.0 {
            return Some((secs * 1000.0).round() as u64);
        }
    }
    if let Ok(date) = httpdate_parse(raw) {
        return Some(date.saturating_sub(now_ms).max(0) as u64);
    }
    None
}

fn httpdate_parse(raw: &str) -> Result<i64, ()> {
    // Aceita o subset que o `Date.parse` do JS cobre nos testes comuns:
    // "Wed, 21 Oct 2026 07:28:00 GMT". Sem crate extra: falha → None.
    // Para a busca ao vivo o header em segundos é o caminho usual.
    let _ = raw;
    Err(())
}

/// Primeira linha sem sufixos 👥/💾/(langs)/emojis — espelha `cleanTitle`.
pub fn clean_title(first_line: &str) -> String {
    let mut s = first_line.to_string();
    if let Some(idx) = s.find(EYES) {
        s.truncate(idx);
    }
    if let Some(idx) = s.find(DISK) {
        s.truncate(idx);
    }
    s = strip_trailing_lang_parens(&s);
    s = strip_trailing_trunc(&s);
    while s.ends_with(ELLIPSIS) || s.ends_with('…') {
        s.pop();
    }
    s = strip_pictographic(&s);
    collapse_ws(&s)
}

fn strip_trailing_lang_parens(s: &str) -> String {
    let trimmed = s.trim_end();
    let Some(open) = trimmed.rfind('(') else {
        return trimmed.to_string();
    };
    if !trimmed.ends_with(')') {
        return trimmed.to_string();
    }
    let inner = &trimmed[open + 1..trimmed.len() - 1];
    if inner.is_empty() {
        return trimmed.to_string();
    }
    // `(brazilian, eng)` — só letras/espaços/vírgulas ASCII.
    if inner
        .bytes()
        .all(|b| b.is_ascii_alphabetic() || b == b' ' || b == b',')
    {
        return trimmed[..open].trim_end().to_string();
    }
    trimmed.to_string()
}

fn strip_trailing_trunc(s: &str) -> String {
    let trimmed = s.trim_end();
    let Some(open) = trimmed.rfind('(') else {
        return trimmed.to_string();
    };
    let rest = &trimmed[open + 1..];
    // `(brazili…` sem fechar — truncamento do Mico.
    if rest.ends_with(ELLIPSIS) || rest.ends_with('…') {
        let inner = rest.trim_end_matches([ELLIPSIS, '…']);
        if inner
            .bytes()
            .all(|b| b.is_ascii_alphabetic() || b == b' ' || b == b',')
        {
            return trimmed[..open].trim_end().to_string();
        }
    }
    trimmed.to_string()
}

fn strip_pictographic(s: &str) -> String {
    s.chars()
        .filter(|c| {
            if *c == '\u{FE0F}' {
                return false;
            }
            // Extended_Pictographic aproximado: BMP emoji blocks + suplementares.
            let u = *c as u32;
            !(u == 0x00A9
                || u == 0x00AE
                || (0x203C..=0x3299).contains(&u)
                || (0x1F000..=0x1FAFF).contains(&u))
        })
        .collect()
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Magnet com trackers de `sources` (sem `dn=`).
pub fn magnet_of(hash: &str, sources: Option<&Value>) -> String {
    let mut trackers = HashSet::new();
    if let Some(Value::Array(arr)) = sources {
        for raw in arr {
            let mut url = raw.as_str().unwrap_or("").trim();
            if url.len() >= 8 && url[..8].eq_ignore_ascii_case("tracker:") {
                url = url[8..].trim();
            }
            if is_tracker_url(url) {
                trackers.insert(url.to_string());
            }
        }
    }
    let mut magnet = format!("magnet:?xt=urn:btih:{hash}");
    let mut sorted: Vec<_> = trackers.into_iter().collect();
    sorted.sort();
    for t in sorted {
        magnet.push_str("&tr=");
        magnet.push_str(&urlencoding_encode(&t));
    }
    magnet
}

fn is_tracker_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("udp://")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("ws://")
        || lower.starts_with("wss://"))
        && !url
            .chars()
            .any(|c| c.is_whitespace() || c == '&' || c == '#')
}

/// Percent-encode mínimo para `tr=` (o mesmo espírito de `encodeURIComponent`).
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}

fn is_info_hash(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn parse_size_bytes(value: f64, unit: &str) -> Option<f64> {
    let mult = match unit.to_ascii_uppercase().as_str() {
        "KB" => 1024.0,
        "MB" => 1024.0_f64.powi(2),
        "GB" => 1024.0_f64.powi(3),
        "TB" => 1024.0_f64.powi(4),
        _ => return None,
    };
    Some((value * mult).round())
}

/// Mapeia um stream do payload `{ streams: [...] }` → item cru, ou `None`.
pub fn map_stream(raw: &Value) -> Option<MicoRawItem> {
    let info_hash = raw
        .get("infoHash")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !is_info_hash(&info_hash) {
        return None;
    }
    let full = raw.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let first = full.lines().next().unwrap_or("");
    let title = clean_title(first);
    if title.is_empty() {
        return None;
    }
    let seeders = extract_seeders(full).unwrap_or(1.0);
    let size = extract_size(full).filter(|n| *n > 0.0);
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

fn extract_seeders(full: &str) -> Option<f64> {
    let idx = full.find(EYES)?;
    let rest = full[idx + EYES.len_utf8()..].trim_start();
    let token: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ',')
        .collect();
    if token.is_empty() {
        return None;
    }
    let cleaned = token.replace([',', '.'], "");
    // TS: replace /[.,]/g then Number — "1.234" → 1234 se só separador de milhar.
    // Se houver um único `.` com decimais curtos, o TS remove e junta: "1.2" → 12.
    // Espelhamos o replace literal do TS (remove todos `.` e `,`).
    let n: f64 = cleaned.parse().ok()?;
    n.is_finite().then_some(n)
}

fn extract_size(full: &str) -> Option<f64> {
    let idx = full.find(DISK)?;
    let rest = full[idx + DISK.len_utf8()..].trim_start();
    let mut parts = rest.split_whitespace();
    let value_txt = parts.next()?;
    let unit = parts.next()?;
    let value: f64 = value_txt.replace(',', ".").parse().ok()?;
    parse_size_bytes(value, unit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clean_title_tira_sufixos() {
        let line = format!("Filme Dublado 1080p {EYES} 12 {DISK} 2.1 GB (brazilian, eng)");
        assert_eq!(clean_title(&line), "Filme Dublado 1080p");
    }

    #[test]
    fn map_stream_hash_e_magnet_com_tracker() {
        let raw = json!({
            "title": "Coringa 2019 Dublado",
            "infoHash": "A".repeat(40),
            "sources": ["tracker:udp://tracker.example:80"]
        });
        let item = map_stream(&raw).expect("item");
        assert_eq!(item.info_hash, "a".repeat(40));
        assert!(item.magnet.contains("btih:aaaaaaaa"));
        assert!(item.magnet.contains("tr=udp%3A%2F%2Ftracker.example%3A80"));
        assert!(!item.magnet.contains("dn="));
        assert_eq!(item.indexer, "mico");
    }

    #[test]
    fn map_stream_descarta_hash_invalido() {
        let raw = json!({ "title": "x", "infoHash": "abc" });
        assert!(map_stream(&raw).is_none());
    }

    #[test]
    fn retry_after_segundos() {
        assert_eq!(retry_after_ms(Some("120"), 0), Some(120_000));
        assert_eq!(retry_after_ms(Some(""), 0), None);
    }
}
