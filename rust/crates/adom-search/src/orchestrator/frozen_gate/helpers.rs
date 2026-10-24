//! Helpers de leitura e coercao do corpus.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

// ── helpers ─────────────────────────────────────────────────────────────────

pub(super) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let bytes = std::fs::read(path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|err| format!("{}: {err}", path.display()))
}

pub(super) fn read_optional<T: for<'de> Deserialize<'de> + Default>(
    path: &Path,
) -> Result<T, String> {
    if !path.is_file() {
        return Ok(T::default());
    }
    read_json(path)
}

pub(super) fn string_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn i64_of(value: &Value, fallback: i64) -> i64 {
    value.as_i64().unwrap_or(fallback)
}

pub(super) fn u64_of(value: &Value, fallback: u64) -> u64 {
    value.as_u64().unwrap_or(fallback)
}

pub(super) fn f64_of(value: &Value, fallback: f64) -> f64 {
    value.as_f64().unwrap_or(fallback)
}

pub(super) fn bool_of(value: &Value, fallback: bool) -> bool {
    value.as_bool().unwrap_or(fallback)
}
