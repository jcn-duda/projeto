//! Parse do envelope Torznab/JSON — porte de `jackett-results.ts`.

use adom_core::{decode_entities, looks_pt_br};
use serde_json::Value;

use super::types::JackettRawItem;

/// Indexers que zeram com `Category[]` na URL (filtro local no `Category`).
pub const CATEGORY_UNFILTERED: &[&str] = &["thepiratebay"];
/// `Category` da resposta inútil (MagnetDownload = Other/8000).
pub const UNRELIABLE_CATEGORY: &[&str] = &["magnetdownload"];
/// Uploader classifica filme como Other — Other passa como desconhecido.
pub const OTHER_AS_UNKNOWN: &[&str] = &["limetorrents"];

/// Balde Torznab: 2000–2999 filme, 5000–5999 TV. Sem categoria → passa.
pub fn in_category_bucket(categories: &Value, bucket: u32, other_as_unknown: bool) -> bool {
    let Some(arr) = categories.as_array() else {
        return true;
    };
    if arr.is_empty() {
        return true;
    }
    let ids: Vec<i64> = arr.iter().filter_map(Value::as_i64).collect();
    if ids
        .iter()
        .any(|&id| id >= i64::from(bucket) && id < i64::from(bucket + 1000))
    {
        return true;
    }
    if !other_as_unknown {
        return false;
    }
    let torznab: Vec<i64> = ids.into_iter().filter(|&id| id > 0 && id < 10_000).collect();
    torznab.iter().all(|&id| (8000..9000).contains(&id))
}

/// Falha da FONTE dentro de HTTP 200 (`Indexers[].Status`/`Error`).
///
/// `Status: 2` = OK. Sem envelope → `None` (ausência ≠ falha).
pub fn indexer_failure(data: &Value) -> Option<String> {
    let envelope = data.get("Indexers")?.as_array()?;
    if envelope.is_empty() {
        return None;
    }
    for entry in envelope {
        if let Some(erro) = entry.get("Error").and_then(Value::as_str) {
            if !erro.is_empty() {
                let first = erro.lines().next().unwrap_or(erro);
                return Some(first.chars().take(200).collect());
            }
        }
        if let Some(status) = entry.get("Status").and_then(Value::as_i64) {
            if status != 2 {
                return Some(format!("Status {status}"));
            }
        }
    }
    None
}

/// Opções de [`map_results`].
#[derive(Debug, Clone, Default)]
pub struct MapOptions<'a> {
    pub is_br: bool,
    pub indexer: &'a str,
    pub category_bucket: u32,
    pub other_as_unknown: bool,
}

/// Converte o JSON Torznab nos itens crus que o collect espera.
pub fn map_results(data: &Value, opts: MapOptions<'_>) -> Vec<JackettRawItem> {
    let all = results_array(data);
    let filtered: Vec<&Value> = if opts.category_bucket > 0 {
        all.iter()
            .filter(|r| {
                in_category_bucket(
                    r.get("Category").unwrap_or(&Value::Null),
                    opts.category_bucket,
                    opts.other_as_unknown,
                )
            })
            .copied()
            .collect()
    } else {
        all
    };

    filtered
        .into_iter()
        .map(|r| {
            let title = decode_entities(r.get("Title").and_then(Value::as_str).unwrap_or(""));
            let magnet = r
                .get("MagnetUri")
                .and_then(Value::as_str)
                .or_else(|| r.get("Guid").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let info_hash = r
                .get("InfoHash")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let seeders = r.get("Seeders").and_then(as_f64);
            let size = r.get("Size").and_then(as_f64);
            let published_at = r
                .get("PublishDate")
                .and_then(Value::as_str)
                .and_then(parse_publish_ms);
            let tracker = r
                .get("Tracker")
                .and_then(Value::as_str)
                .or_else(|| r.get("TrackerId").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let indexer = if opts.indexer.is_empty() {
                r.get("TrackerId")
                    .and_then(Value::as_str)
                    .or_else(|| r.get("Tracker").and_then(Value::as_str))
                    .unwrap_or("")
                    .to_string()
            } else {
                opts.indexer.to_string()
            };
            let download_url = r
                .get("Link")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let is_br = opts.is_br || looks_pt_br(&title);
            JackettRawItem {
                title,
                magnet,
                info_hash,
                seeders,
                size,
                published_at,
                tracker,
                indexer,
                download_url,
                is_br,
            }
        })
        .collect()
}

fn results_array(data: &Value) -> Vec<&Value> {
    if let Some(arr) = data.get("Results").and_then(Value::as_array) {
        return arr.iter().collect();
    }
    if let Some(arr) = data.as_array() {
        return arr.iter().collect();
    }
    Vec::new()
}

fn as_f64(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_u64().map(|n| n as f64))
}

/// Subconjunto determinístico do `Date.parse` do Jackett (ISO com `Z`/offset).
fn parse_publish_ms(raw: &str) -> Option<i64> {
    // Aceita o que o Jackett manda tipicamente: `2024-01-15T12:00:00Z` ou com
    // offset. Sem chrono externo: só o formato estrito YYYY-MM-DDTHH:MM:SS[.fff]Z.
    let s = raw.trim();
    if s.len() < 19 {
        return None;
    }
    let (date, rest) = s.split_at(10);
    if !rest.starts_with('T') && !rest.starts_with(' ') {
        return None;
    }
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y: i64 = parts[0].parse().ok()?;
    let mo: i64 = parts[1].parse().ok()?;
    let d: i64 = parts[2].parse().ok()?;
    let time = &rest[1..];
    let (h, mi, sec) = parse_hms(time)?;
    civil_to_epoch_ms(y, mo, d, h, mi, sec)
}

fn parse_hms(time: &str) -> Option<(i64, i64, i64)> {
    let clean = time.trim_end_matches('Z');
    let clean = clean.split('+').next()?.split('-').next()?;
    let clean = clean.split('.').next()?;
    let parts: Vec<&str> = clean.split(':').collect();
    if parts.len() < 2 {
        return None;
    }
    let h: i64 = parts[0].parse().ok()?;
    let mi: i64 = parts[1].parse().ok()?;
    let sec: i64 = if parts.len() > 2 {
        parts[2].parse().ok()?
    } else {
        0
    };
    Some((h, mi, sec))
}

fn civil_to_epoch_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, sec: i64) -> Option<i64> {
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    // Algoritmo civil → dias desde epoch (Howard Hinnant), UTC.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec;
    Some(secs.saturating_mul(1000))
}

pub fn category_policy(indexer: &str) -> (bool, bool, bool) {
    let other_as_unknown = OTHER_AS_UNKNOWN.contains(&indexer);
    let no_category_in_url =
        CATEGORY_UNFILTERED.contains(&indexer) || other_as_unknown;
    let unreliable = UNRELIABLE_CATEGORY.contains(&indexer);
    let filter_locally = no_category_in_url && !unreliable;
    let send_category = !(no_category_in_url || unreliable);
    (send_category, filter_locally, other_as_unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn map_results_marca_is_br_pelo_titulo() {
        let data = json!({
            "Results": [{
                "Title": "Filme Dublado 1080p",
                "MagnetUri": "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "InfoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "Seeders": 10,
                "Size": 1000,
                "Tracker": "YTS",
                "TrackerId": "yts",
                "Link": "https://tracker.example/dl"
            }]
        });
        let items = map_results(
            &data,
            MapOptions {
                is_br: false,
                indexer: "yts",
                ..MapOptions::default()
            },
        );
        assert_eq!(items.len(), 1);
        assert!(items[0].is_br, "looks_pt_br deve ligar is_br");
        assert_eq!(items[0].indexer, "yts");
        assert_eq!(
            items[0].download_url.as_deref(),
            Some("https://tracker.example/dl")
        );
    }

    #[test]
    fn indexer_failure_le_envelope() {
        let ok = json!({ "Indexers": [{ "Status": 2, "Error": null }], "Results": [] });
        assert!(indexer_failure(&ok).is_none());
        let dead = json!({
            "Indexers": [{ "Status": 1, "Error": "BadGateway\nstack" }],
            "Results": []
        });
        assert_eq!(indexer_failure(&dead).as_deref(), Some("BadGateway"));
        let bare = json!([{ "Title": "x" }]);
        assert!(indexer_failure(&bare).is_none());
    }
}
