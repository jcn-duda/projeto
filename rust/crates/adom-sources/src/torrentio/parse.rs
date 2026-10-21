//! Parsing do `title`/metadados do Torrentio — porte de `parseMetadata` /
//! `mapStream` em `src/providers/torrentio.ts`.

use super::types::TorrentioRawItem;

/// Linha `👤 seeders 💾 X IB ⚙️ fonte` (emojis literais do payload).
const META_USER: char = '\u{1F464}'; // 👤
const META_DISK: char = '\u{1F4BE}'; // 💾
const META_GEAR: char = '\u{2699}'; // ⚙ (pode vir com VS16)

/// Resultado de [`parse_metadata`].
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedMetadata {
    pub title: String,
    pub seeders: Option<f64>,
    pub size_bytes: f64,
    pub source: String,
}

/// Extrai a linha de metadados e devolve o texto DEPOIS de removê-la
/// (linhas de arquivo e anotações como `[RD+]` preservadas).
pub fn parse_metadata(title: &str) -> ParsedMetadata {
    let mut seeders = None;
    let mut size_bytes = 0.0_f64;
    let mut source = String::new();
    let mut kept: Vec<&str> = Vec::new();
    for raw in title.split('\n') {
        let line = raw.trim();
        if let Some(parsed) = match_metadata_line(line) {
            seeders = parsed.0;
            size_bytes = parsed.1;
            source = parsed.2;
            continue;
        }
        if !line.is_empty() {
            kept.push(line);
        }
    }
    ParsedMetadata {
        title: kept.join("\n"),
        seeders,
        size_bytes,
        source,
    }
}

fn match_metadata_line(line: &str) -> Option<(Option<f64>, f64, String)> {
    let rest = line.trim_start();
    let rest = strip_prefix_char(rest, META_USER)?;
    let rest = rest.trim_start();
    let (seeders_txt, rest) = take_until_char(rest, META_DISK)?;
    let rest = rest.trim_start();
    let (size_txt, rest) = take_token(rest)?;
    let rest = rest.trim_start();
    let (unit_txt, rest) = take_token(rest)?;
    let rest = rest.trim_start();
    let rest = strip_gear(rest)?;
    let source = rest.trim().to_string();
    if source.is_empty() {
        return None;
    }
    let seeders = to_number(seeders_txt.trim());
    let size_val = to_number(size_txt)?;
    let size_bytes = parse_size_bytes(size_val, unit_txt)?;
    Some((seeders, size_bytes, source))
}

fn strip_prefix_char(s: &str, ch: char) -> Option<&str> {
    let mut chars = s.chars();
    if chars.next() == Some(ch) {
        Some(chars.as_str())
    } else {
        None
    }
}

fn strip_gear(s: &str) -> Option<&str> {
    let mut chars = s.chars();
    if chars.next() != Some(META_GEAR) {
        return None;
    }
    let mut rest = chars.as_str();
    // Variation Selector-16 (emoji presentation) opcional.
    if let Some(stripped) = rest.strip_prefix('\u{FE0F}') {
        rest = stripped;
    }
    Some(rest)
}

fn take_until_char(s: &str, ch: char) -> Option<(&str, &str)> {
    let idx = s.find(ch)?;
    Some((&s[..idx], &s[idx + ch.len_utf8()..]))
}

fn take_token(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    let end = s
        .char_indices()
        .find(|(_, c)| c.is_whitespace())
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    Some((&s[..end], &s[end..]))
}

fn to_number(text: &str) -> Option<f64> {
    let cleaned = text.replace(',', "");
    let n: f64 = cleaned.parse().ok()?;
    n.is_finite().then_some(n)
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
pub fn map_stream(raw: &serde_json::Value) -> Option<TorrentioRawItem> {
    let info_hash = raw
        .get("infoHash")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !is_info_hash(&info_hash) {
        return None;
    }
    let title_raw = raw.get("title").and_then(|v| v.as_str()).unwrap_or("");
    let parsed = parse_metadata(title_raw);
    let fallback = raw
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| raw.get("title").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim();
    let title_text = if parsed.title.is_empty() {
        fallback.to_string()
    } else {
        parsed.title
    };
    if title_text.is_empty() {
        return None;
    }
    let file_idx = parse_file_idx(raw.get("fileIdx"));
    let size = if parsed.size_bytes > 0.0 {
        Some(parsed.size_bytes)
    } else {
        None
    };
    let tracker = if parsed.source.is_empty() {
        None
    } else {
        Some(parsed.source)
    };
    Some(TorrentioRawItem {
        title: title_text,
        info_hash: info_hash.to_ascii_lowercase(),
        seeders: parsed.seeders.unwrap_or(0.0),
        size,
        tracker,
        indexer: "torrentio".into(),
        file_idx,
    })
}

fn is_info_hash(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit()) && !s.bytes().all(|b| b == b'0')
}

fn parse_file_idx(value: Option<&serde_json::Value>) -> Option<i64> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    let n = match value {
        serde_json::Value::Number(num) => num.as_f64()?,
        serde_json::Value::String(s) => s.parse().ok()?,
        _ => return None,
    };
    if !n.is_finite() {
        return None;
    }
    // Math.trunc: em direção a zero.
    Some(n.trunc() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_remove_linha_meta_e_preserva_arquivo() {
        let meta = format!("{META_USER} 1,234 {META_DISK} 2.4 GB {META_GEAR}\u{FE0F} Torrentio");
        let title = format!(
            "{meta}\nGuardiões da Galáxia Vol. 3 (2023) [4K] [Dual] [RD+]\narquivo1.mkv\narquivo2.mkv"
        );
        let parsed = parse_metadata(&title);
        assert_eq!(
            parsed.title,
            "Guardiões da Galáxia Vol. 3 (2023) [4K] [Dual] [RD+]\narquivo1.mkv\narquivo2.mkv"
        );
        assert_eq!(parsed.seeders, Some(1234.0));
        assert_eq!(parsed.size_bytes, (2.4 * 1024.0_f64.powi(3)).round());
        assert_eq!(parsed.source, "Torrentio");
    }

    #[test]
    fn map_stream_preserva_file_idx_e_hash_lower() {
        let raw = json!({
            "title": "Filme",
            "infoHash": "A".repeat(40),
            "fileIdx": 2.9
        });
        let item = map_stream(&raw).expect("item");
        assert_eq!(item.info_hash, "a".repeat(40));
        assert_eq!(item.file_idx, Some(2));
        assert_eq!(item.indexer, "torrentio");
    }

    #[test]
    fn map_stream_descarta_hash_invalido() {
        let raw = json!({ "title": "x", "infoHash": "abc" });
        assert!(map_stream(&raw).is_none());
    }
}
