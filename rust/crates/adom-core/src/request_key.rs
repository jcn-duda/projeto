//! Porte de `src/utils/request-key.ts`: `accountScope`, `streamsCacheScope` e
//! `streamsCacheKey`.
//!
//! A identidade de uma conta entra no cache SEM a credencial: a API key vira só
//! um SHA-256. A comparação é byte a byte nos casos do TS capturados no golden
//! `rust/golden/request-key.jsonl`) e a parte delicada é o `JSON.stringify` do
//! `shape` (as `options` sem `debridApiKey`):
//!
//! - a ORDEM das chaves segue a regra de propriedades do objeto JS — chaves com
//!   índice de array (inteiro canônico em `0..2^32-1`, excluído o próprio
//!   `2^32-1`) vêm primeiro, em ordem CRESCENTE, e só depois as demais na ordem
//!   de inserção. O `JSON.parse` do oráculo já entrega os objetos assim; o
//!   `preserve_order` do `serde_json` preserva a inserção, mas NÃO reordena por
//!   índice, então a serialização aqui reordena explicitamente.
//! - as fugas de string (`\b \f \n \r \t`, `\u00xx` para os outros de controle,
//!   restante cru em UTF-8) e a formatação numérica do JS (exponencial fora de
//!   `1e-6 .. 1e21`, com `+`/`-` explícito) são as mesmas já medidas em
//!   `js_text`. LIMITE CONHECIDO: o inteiro só é exato até `2^53`; acima disso o
//!   `JSON.parse` do Node já arredondou para f64, e este módulo continua
//!   emitindo os dígitos exatos do `serde_json` — limite de paridade não
//!   exercitado pelo corpus atual.
//!
//! Helpers privados: o `js_text` do crate cobre `String()`/`JSON.stringify`, mas
//! o `stringify` de lá NÃO reordena chaves de índice e o módulo estava sob
//! correção concorrente. Para o registro em `lib.rs` sem tocar em `js_text.rs`,
//! a coerção, a formatação numérica e a serialização ordenada vivem aqui
//! (duplicação mínima, de propósito, com risco de drift a vigiar). O único
//! símbolo reusado é `prefix('streams')` de `cache_keys`, fonte única do
//! namespace.
//!
//! DIVERGÊNCIA (fora do corpus): `options` que não seja objeto JSON é tratado
//! como `{}` (o TS jogaria `TypeError` ao desestruturar `null`, e espalharia os
//! índices de um array ou de uma string). O corpus só exercita objetos; o caso é sintetizado no
//! teste próprio deste módulo, não no golden.

use serde_json::{Map, Number, Value};

use crate::cache_keys::prefix;

/// `accountScope(apiKey)`: SHA-256 (hex) da coerção `String(apiKey)`, ou
/// `"none"` quando falsy (`undefined`, `null`, `""`, `0`, `false`).
pub fn account_scope(api_key: &Value) -> String {
    if !js_truthy(api_key) {
        return "none".to_string();
    }
    sha256_hex(js_to_string(api_key).as_bytes())
}

/// `streamsCacheScope(options)`: `JSON.stringify(options \ debridApiKey)` na
/// ordem do JS, seguido de `:account:<accountScope(debridApiKey)>`.
pub fn streams_cache_scope(options: &Value) -> String {
    let debrid = options
        .as_object()
        .and_then(|map| map.get("debridApiKey"))
        .unwrap_or(&Value::Null);
    let account = account_scope(debrid);
    format!(
        "{}:account:{}",
        js_stringify(&shape_without(options, "debridApiKey")),
        account
    )
}

/// `streamsCacheKey(type, id, options)`: `<prefix streams><type>:<id>:<scope>`.
///
/// `type`/`id` entram crus (o TS não normaliza nada aqui); o namespace vem de
/// `prefix("streams")` para que um bump em `cache_keys` acompanhe o golden.
pub fn streams_cache_key(stream_type: &str, id: &str, options: &Value) -> String {
    format!(
        "{}{}:{}:{}",
        prefix("streams"),
        stream_type,
        id,
        streams_cache_scope(options)
    )
}

/// `{...options}` sem a chave `omit` (só o nível de cima; aninhadas ficam, como
/// no rest destructuring do TS).
fn shape_without(options: &Value, omit: &str) -> Value {
    let Some(map) = options.as_object() else {
        return Value::Object(Map::new());
    };
    let mut out = Map::new();
    for (key, value) in map {
        if key != omit {
            out.insert(key.clone(), value.clone());
        }
    }
    Value::Object(out)
}

/// `JSON.stringify(value)` compacto, com a ordem de propriedades do JS nos
/// objetos.
fn js_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(&mut out, value);
    out
}

fn write_json(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&js_number_to_string(n)),
        Value::String(s) => write_json_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, val)) in ordered_entries(map).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, key);
                out.push(':');
                write_json(out, val);
            }
            out.push('}');
        }
    }
}

/// Chaves na ordem de propriedades do JS: índice de array crescente primeiro,
/// depois as demais na ordem de inserção do mapa.
fn ordered_entries(map: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut others: Vec<(&String, &Value)> = Vec::new();
    for (key, value) in map {
        match array_index(key) {
            Some(i) => indexed.push((i, key, value)),
            None => others.push((key, value)),
        }
    }
    indexed.sort_by_key(|(i, _, _)| *i);
    let mut ordered: Vec<(&String, &Value)> = Vec::with_capacity(map.len());
    ordered.extend(indexed.into_iter().map(|(_, key, value)| (key, value)));
    ordered.extend(others);
    ordered
}

/// Índice de array do JS: inteiro canônico em `0..2^32-1`, sem zero à esquerda,
/// excluído o próprio `2^32-1` (`4294967295`).
fn array_index(key: &str) -> Option<u32> {
    if key == "0" {
        return Some(0);
    }
    if key.is_empty() || key.starts_with('0') || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    match key.parse::<u32>() {
        Ok(n) if n != u32::MAX => Some(n),
        _ => None,
    }
}

/// Fugas de string do `JSON.stringify`: `\b \f \n \r \t`, `\u00xx` para os
/// demais de controle (hex minúsculo); o resto sai cru (UTF-8).
fn write_json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `String(valor)` do JS para tipos de um JSON parseado (array junta por
/// vírgula; objeto vira `[object Object]`).
fn js_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(n),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_to_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// Formatação numérica do JS (`Number::toString`): inteiro exato; exponencial só
/// fora de `1e-6 .. 1e21`, com sinal de expoente explícito. `-0` é `"0"`.
fn js_number_to_string(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if f == 0.0 {
        return "0".to_string();
    }
    if !f.is_finite() {
        return "null".to_string();
    }
    let abs = f.abs();
    if !(1e-6..1e21).contains(&abs) {
        // `{:e}` do Rust já é a forma normalizada; o JS só exige o sinal do
        // expoente (`1e+21`, `1.5e-7`).
        let sci = format!("{f:e}");
        let (mantissa, exponent) = sci.split_once('e').unwrap_or(("0", "0"));
        let e: i64 = exponent.parse().unwrap_or(0);
        return format!("{mantissa}e{}{}", if e < 0 { '-' } else { '+' }, e.abs());
    }
    format!("{f}")
}

/// Falsidade do JS (`apiKey || …`) sobre um valor JSON.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        // `0` (e `-0`) é falsy; sem NaN vindo de JSON.
        Value::Number(n) => n.as_f64().is_none_or(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        // `[]` e `{}` são truthy no JS.
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// SHA-256 em hex minúsculo (mesmo `crypto.createHash('sha256').update(s,'utf8')`).
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;

    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest.as_slice() {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn account_scope_falsy_vira_none() {
        for falsy in [Value::Null, json!(""), json!(0), json!(false)] {
            assert_eq!(account_scope(&falsy), "none");
        }
    }

    #[test]
    fn account_scope_coage_objeto_e_numero() {
        assert_eq!(
            account_scope(&json!({"token": "fake"})),
            sha256_hex(b"[object Object]")
        );
        assert_eq!(account_scope(&json!(123456789)), sha256_hex(b"123456789"));
    }

    #[test]
    fn scope_reordena_indice_de_array_antes_das_demais() {
        assert_eq!(
            streams_cache_scope(&json!({"10": "dez", "2": "dois", "a": "x"})),
            "{\"2\":\"dois\",\"10\":\"dez\",\"a\":\"x\"}:account:none"
        );
    }

    #[test]
    fn scope_remove_apenas_o_debrid_api_key_de_cima() {
        assert_eq!(
            streams_cache_scope(&json!({"nested": {"debridApiKey": "inner"}, "maxResults": 1})),
            "{\"nested\":{\"debridApiKey\":\"inner\"},\"maxResults\":1}:account:none"
        );
    }

    #[test]
    fn scope_trata_options_nao_objeto_como_vazio() {
        assert_eq!(streams_cache_scope(&Value::Null), "{}:account:none");
        assert_eq!(streams_cache_scope(&json!(7)), "{}:account:none");
    }

    #[test]
    fn numero_do_js_cobre_limites_do_corpus() {
        assert_eq!(js_number_to_string(&Number::from(0)), "0");
        assert_eq!(
            js_number_to_string(&Number::from_f64(1e21).unwrap()),
            "1e+21"
        );
        assert_eq!(js_number_to_string(&Number::from_f64(0.1).unwrap()), "0.1");
        assert_eq!(js_number_to_string(&Number::from_f64(-0.0).unwrap()), "0");
    }

    #[test]
    fn array_index_do_js() {
        assert_eq!(array_index("0"), Some(0));
        assert_eq!(array_index("10"), Some(10));
        assert_eq!(array_index("4294967294"), Some(4294967294));
        assert_eq!(array_index("4294967295"), None);
        assert_eq!(array_index("01"), None);
        assert_eq!(array_index(""), None);
        assert_eq!(array_index("a"), None);
        assert_eq!(array_index("-1"), None);
    }
}
