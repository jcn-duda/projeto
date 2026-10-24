//! Codec da LINHA de `crawl_url` e dos contadores: `renderUrl`, `parseUrlRow`,
//! `parseStatus` e `emptyCounters`. O `url_key` é o caminho via
//! `crawl_url_key` (reuso do porte existente), nunca a URL inteira.

use serde_json::{Map, Value};

use crate::crawl_url_key::crawl_url_key;
use crate::js_text::{js_number, js_to_string};

use super::row::Row;
use super::{num, or_zero, truthy_string};

/// `kind` do código: qualquer coisa que não seja exatamente `'tv_show'` vira
/// `'movie'`.
pub(super) fn kind_of(v: &Value) -> String {
    match v.get("kind").and_then(Value::as_str) {
        Some("tv_show") => "tv_show".to_string(),
        _ => "movie".to_string(),
    }
}

/// `r.imdb == null ? null : String(r.imdb)` — `0` e `''` passam (só `null`
/// explícito e ausência viram `null`).
pub(super) fn imdb_opt(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(x) => Some(js_to_string(x)),
    }
}

/// `imdb` como valor JSON (string ou `null`).
pub(super) fn imdb_from(v: Option<&Value>) -> Value {
    imdb_opt(v).map(Value::String).unwrap_or(Value::Null)
}

/// `Number(v[key]) || 0` de uma propriedade ausente/`null` → campo `0`.
pub(super) fn num_field(v: &Value, key: &str) -> f64 {
    or_zero(js_number(v.get(key).unwrap_or(&Value::Null)))
}

/// `renderUrl(row)` — array posicional das colunas, com `url_key` derivado.
pub fn render_url(row: &Value) -> Value {
    let url = truthy_string(row.get("url"));
    Value::Array(vec![
        Value::String(truthy_string(row.get("site"))),
        Value::String(url.clone()),
        Value::String(crawl_url_key(&url)),
        Value::String(truthy_string(row.get("lastmod"))),
        Value::String(kind_of(row)),
        Value::String(truthy_string(row.get("status"))),
        imdb_from(row.get("imdb")),
        num(num_field(row, "tries")),
        num(num_field(row, "nextAt")),
        num(num_field(row, "checkedAt")),
        num(num_field(row, "releases")),
        Value::String(truthy_string(row.get("error"))),
        Value::String(truthy_string(row.get("progress"))),
        num(num_field(row, "addedAt")),
    ])
}

/// `parseStatus(value)` — status fora da lista conhecida vira `pending`
/// (linha legada volta a ser processada em vez de sumir dos contadores).
pub fn parse_status(value: &Value) -> String {
    let s = value.as_str().unwrap_or("");
    match s {
        "pending" | "inflight" | "done" | "no-torrent" | "no-work" | "error" | "simulated"
        | "partial" => s.to_string(),
        _ => "pending".to_string(),
    }
}

/// `parseUrlRow(r)` — linha crua (snake_case) → linha normalizada (camelCase).
pub fn parse_url_row(r: &Value) -> Value {
    Row::from_snake(r).to_value()
}

/// `emptyCounters()` — todos os status zerados, na ordem do fonte.
pub fn empty_counters() -> Value {
    let mut m = Map::new();
    for k in [
        "pending",
        "inflight",
        "done",
        "no-torrent",
        "no-work",
        "error",
        "simulated",
        "partial",
    ] {
        m.insert(k.to_string(), num(0.0));
    }
    Value::Object(m)
}
