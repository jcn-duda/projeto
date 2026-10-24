//! Normalizacao dos pedacos de metadados (ano, contagem de episodios).

use serde_json::Value;

pub(super) fn year_text_of(year: &Value) -> String {
    match year {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// Primeiro ano de 4 dígitos (`Number(String(year).match(/(?:19|20)\d{2}/))`).
pub(super) fn first_year(text: &str) -> i64 {
    let bytes = text.as_bytes();
    for window in bytes.windows(4) {
        let candidate = std::str::from_utf8(window).unwrap_or("");
        if candidate.len() == 4
            && (candidate.starts_with("19") || candidate.starts_with("20"))
            && candidate.bytes().all(|b| b.is_ascii_digit())
        {
            return candidate.parse::<i64>().unwrap_or(0);
        }
    }
    0
}

pub(super) fn int_of(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

/// `[(temporada, episódios)]` a partir de `meta.videos` (Cinemeta): conta
/// EPISÓDIOS distintos por temporada — o `annotateEpisodeSizes` usa a contagem
/// para a média do 💾 de pack.
pub(super) fn episode_counts(meta: Option<&Value>) -> Vec<(i64, i64)> {
    // O `getMeta` do Node normaliza o Cinemeta para `episodes: {"1": 7, ...}`
    // (contagem por temporada) — é essa a forma que a rota interna devolve e
    // que o gate congelado grava. Sem aceitá-la, `ctx.episode_counts` ficava
    // vazio e o 💾 médio de pack nunca era calculado no Rust.
    if let Some(map) = meta
        .and_then(|m| m.get("episodes"))
        .and_then(Value::as_object)
    {
        let mut out: Vec<(i64, i64)> = map
            .iter()
            .filter_map(|(season, count)| season.parse::<i64>().ok().zip(count.as_i64()))
            .collect();
        out.sort_by_key(|(season, _)| *season);
        if !out.is_empty() {
            return out;
        }
    }
    let Some(videos) = meta.and_then(|m| m.get("videos")).and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<(i64, Vec<i64>)> = Vec::new();
    for video in videos {
        let Some(season) = video.get("season").and_then(Value::as_i64) else {
            continue;
        };
        let Some(episode) = video.get("episode").and_then(Value::as_i64) else {
            continue;
        };
        match out.iter_mut().find(|(s, _)| *s == season) {
            Some((_, episodes)) => {
                if !episodes.contains(&episode) {
                    episodes.push(episode);
                }
            }
            None => out.push((season, vec![episode])),
        }
    }
    out.into_iter()
        .map(|(season, episodes)| (season, episodes.len() as i64))
        .collect()
}
