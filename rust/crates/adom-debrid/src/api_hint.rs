//! Dica de play (`episode` do POST) → `PlayHint` do seletor. Extraído de
//! `api_dispatch.rs` pela catraca de 400 linhas.

use adom_core::{PlayHint, WorkHint};
use serde_json::Value;

pub(super) fn play_hint(raw: &Option<Value>) -> PlayHint {
    let Some(Value::Object(map)) = raw else {
        return PlayHint::default();
    };
    PlayHint {
        season: json_i64(map.get("season")),
        episode: json_i64(map.get("episode")),
        work: map.get("work").and_then(work_hint),
        dubbed: map.get("dubbed").and_then(Value::as_bool).unwrap_or(false),
    }
}

fn work_hint(value: &Value) -> Option<WorkHint> {
    let map = value.as_object()?;
    let names = map.get("names").and_then(Value::as_array).map(|list| {
        list.iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect()
    });
    Some(WorkHint {
        names: names.unwrap_or_default(),
        year: json_i64(map.get("year")),
        pack: map.get("pack").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn json_i64(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    match value {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().filter(|n| n.is_finite()).map(|n| n as i64)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}
