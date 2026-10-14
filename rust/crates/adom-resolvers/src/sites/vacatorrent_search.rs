//! Busca AJAX do VacaTorrent (`search_posts`): JSON → obras, o `parseSearchJson`
//! de `resolvers/profiles/vacatorrent-parsers.ts`. O filtro por consulta e
//! temporada (`filterSearchPosts`) depende de `matchesResolverQuery` e
//! `matchesSeasonSeason` e não é portado aqui.
//!
//! Os coercions do JS (`||`, `String()`, `Number()`) estão em `js_*` para
//! reproduzir o parse de payload de terceiro campo a campo.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use super::shapes::{decode_entities, resolve_url, strip_tags};
use crate::common::rules::compile;

/// Obra da busca AJAX (`VacaWork`): `year` é `None` fora de 1900..=2100.
#[derive(Debug, Clone, PartialEq)]
pub struct VacaWork {
    pub url: String,
    pub title: String,
    pub is_movie: bool,
    pub year: Option<u32>,
    pub poster: Option<String>,
}

static BODY: LazyLock<Regex> = LazyLock::new(|| compile(r"(?i)<body{B}[^>]*>([\s\S]*?)</body>"));
static PRE: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?i)^<pre{B}[^>]*>([\s\S]*?)</pre>(?:\s*<div{B}[^>]*{B}class=["']json-formatter-container["'][^>]*>[\s\S]*</div>)?\s*$"#,
    )
});

/// `unwrapSearchJson`: só o envelope HTML (`<body>`/`<pre>`) sai; JSON cru passa intacto.
pub fn unwrap_search_json(text: &str) -> String {
    let raw = text.trim();
    if !raw.starts_with('<') {
        return text.to_string();
    }
    let body = match BODY.captures(raw) {
        Some(c) => c[1].to_string(),
        None => raw.to_string(),
    };
    let inner = match PRE.captures(body.trim()) {
        Some(c) => c[1].to_string(),
        None => body,
    };
    decode_entities(&inner).trim().to_string()
}

/// `parseSearchJson`: entradas com título e link, sem repetição de URL.
/// `Err` quando o payload não é JSON ou não tem a lista de resultados.
pub fn parse_search_json(text: &str, base_url: &str) -> Result<Vec<VacaWork>, String> {
    let parsed: Value = serde_json::from_str(&unwrap_search_json(text))
        .map_err(|_| "vacatorrent: resposta de busca inválida".to_string())?;
    let entries = search_entries(&parsed)
        .ok_or_else(|| "vacatorrent: formato de busca inválido".to_string())?;

    let mut posts = Vec::new();
    let mut seen = HashSet::new();
    for raw in entries {
        if !truthy(Some(raw)) {
            continue;
        }
        // `raw.title` de um primitivo truthy é `undefined`: sem objeto não há entrada.
        let Some(obj) = raw.as_object() else {
            continue;
        };
        let title = strip_tags(&js_str(obj.get("title"))).trim().to_string();
        // `raw.link || raw.url`: o primeiro truthy; sem nenhum, a entrada cai fora.
        let link = [obj.get("link"), obj.get("url")]
            .into_iter()
            .flatten()
            .find(|v| truthy(Some(*v)))
            .map(js_string);
        let Some(link) = link.filter(|_| !title.is_empty()) else {
            continue;
        };
        let Some(resolved) = resolve_url(&link, Some(base_url)) else {
            continue;
        };
        if !seen.insert(resolved.clone()) {
            continue;
        }
        let is_movie = js_str(obj.get("type")).to_lowercase().contains("filme");
        let year = js_number(obj.get("year"));
        let year = (year.is_finite() && (1900.0..=2100.0).contains(&year)).then_some(year as u32);
        let poster = match obj.get("thumbnail") {
            Some(thumb) if truthy(Some(thumb)) => Some(decode_entities(&js_string(thumb))),
            _ => None,
        };
        posts.push(VacaWork {
            url: resolved,
            title,
            is_movie,
            year,
            poster,
        });
    }
    Ok(posts)
}

/// `parsed.results ?? parsed.posts` e exige array; null/ausente cai no próximo.
fn search_entries(parsed: &Value) -> Option<&Vec<Value>> {
    match parsed {
        Value::Array(list) => Some(list),
        Value::Object(obj) => {
            let results = obj.get("results").filter(|v| !v.is_null());
            results.or_else(|| obj.get("posts"))?.as_array()
        }
        _ => None,
    }
}

/// Falsy do JS: `null`, `undefined`, `false`, `0`, `NaN` e `""`.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v || '')`: vazio quando o valor é falsy.
fn js_str(value: Option<&Value>) -> String {
    if truthy(value) {
        js_string(value.unwrap_or(&Value::Null))
    } else {
        String::new()
    }
}

/// `String(v)` para os tipos que o JSON de busca usa.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// `Number(v)`: ausente é NaN; texto vazio/nulo/boolean viram 0/1.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else if t.chars().all(|c| c.is_ascii_digit() || "+-.eE".contains(c)) {
                t.parse::<f64>().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
        Some(_) => f64::NAN,
    }
}
