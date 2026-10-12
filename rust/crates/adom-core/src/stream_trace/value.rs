//! Modelo de valor do JS usado pelo ledger `stream_trace`.
//!
//! O ledger roda sobre itens CRUS e streams e recebe payloads já serializados;
//! os valores são objetos/arrays de ordem de inserção que carregam `undefined`,
//! `NaN` e `Infinity` — que o `serde_json` estrito não representa. Textos que
//! podem partir um par surrogate (rótulo/chupim cortados em unidades UTF-16) são
//! [`JsText`]; a renderização usa o `js_stringify` para escapar o órfão igual ao
//! `JSON.stringify` do Node.

use serde_json::Value;

use crate::js_text::js_number_of_str;
use crate::js_text16::JsText;

/// Valor no modelo do JS (objeto/array de ordem de inserção, com `undefined`,
/// `NaN`/`Infinity` e texto em unidades UTF-16).
#[derive(Clone, Debug, PartialEq)]
pub enum TraceValue {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Text(JsText),
    Array(Vec<TraceValue>),
    Object(Vec<(String, TraceValue)>),
}

impl TraceValue {
    /// `String(s)` de um texto já válido em UTF-8.
    pub fn text(s: &str) -> Self {
        Self::Text(JsText::from_str(s))
    }

    /// `serde_json::Value` -> modelo do JS (ordem de inserção preservada).
    pub fn from_json(v: &Value) -> Self {
        match v {
            Value::Null => Self::Null,
            Value::Bool(b) => Self::Bool(*b),
            Value::Number(n) => Self::Num(n.as_f64().unwrap_or(f64::NAN)),
            Value::String(s) => Self::Text(JsText::from_str(s)),
            Value::Array(a) => Self::Array(a.iter().map(Self::from_json).collect()),
            Value::Object(m) => Self::Object(
                m.iter()
                    .map(|(k, val)| (k.clone(), Self::from_json(val)))
                    .collect(),
            ),
        }
    }

    /// Leitura de campo de objeto (`undefined` fora de objeto).
    pub fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(e) => e.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// Escrita em campo de objeto (no-op se o valor não for objeto).
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Self> {
        match self {
            Self::Object(e) => e.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// `obj[k]=v`: substitui mantendo a POSIÇÃO, ou anexa. No-op fora de objeto.
    pub fn set_key(&mut self, key: &str, value: Self) {
        if let Self::Object(entries) = self {
            match entries.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = value,
                None => entries.push((key.to_string(), value)),
            }
        }
    }

    /// `Boolean(x)` do JS.
    pub fn truthy(&self) -> bool {
        match self {
            Self::Undefined | Self::Null => false,
            Self::Bool(b) => *b,
            Self::Num(n) => *n != 0.0 && !n.is_nan(),
            Self::Text(t) => !t.is_empty(),
            Self::Array(_) | Self::Object(_) => true,
        }
    }

    /// `String(x)` do JS (array junta por vírgula; objeto vira `[object Object]`).
    pub fn to_text(&self) -> JsText {
        match self {
            Self::Undefined => JsText::from_str("undefined"),
            Self::Null => JsText::from_str("null"),
            Self::Bool(b) => JsText::from_str(if *b { "true" } else { "false" }),
            Self::Num(n) => JsText::from_str(&num_to_string(*n)),
            Self::Text(t) => t.clone(),
            Self::Array(items) => {
                let mut out = JsText::default();
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push_str(",");
                    }
                    if !matches!(item, Self::Undefined | Self::Null) {
                        out.push(&item.to_text());
                    }
                }
                out
            }
            Self::Object(_) => JsText::from_str("[object Object]"),
        }
    }

    /// `Number(x)` do JS (ToPrimitive via `String`).
    pub fn number(&self) -> f64 {
        match self {
            Self::Num(n) => *n,
            Self::Undefined => f64::NAN,
            Self::Null => 0.0,
            Self::Bool(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            Self::Text(t) => js_number_of_str(&js_text_to_string(t)),
            Self::Array(_) | Self::Object(_) => {
                js_number_of_str(&js_text_to_string(&self.to_text()))
            }
        }
    }

    /// `JSON.stringify(x)`: `undefined` no topo vira a palavra, em array vira
    /// `null` e em objeto a chave é omitida; NaN/Infinity viram `null`; texto usa
    /// o `js_stringify` (órfão escapado).
    pub fn js_stringify(&self) -> String {
        let mut out = String::new();
        write_json(&mut out, self, true);
        out
    }
}

/// `String` do JsText quando bem formado; lossy só fora da coerção numérica.
pub(crate) fn js_text_to_string(t: &JsText) -> String {
    String::from_utf16_lossy(t.as_units())
}

/// `{ ...v }` do JS (CopyDataProperties): objeto/array/string geram objeto NOVO
/// com as chaves próprias enumeráveis na ordem da fonte; `null`, `undefined` e
/// primitivos sem campos geram `{}`. É o spread da forma fixa do
/// `cloneStreamTrace` (`stages: { ...source.stages }` e
/// `items.map((item) => ({ ...item }))`). Array/string indexam os ELEMENTOS
/// inteiros (não os pontos de código): a string é indexada por unidade UTF-16.
pub(crate) fn spread_object(v: Option<&TraceValue>) -> TraceValue {
    match v {
        Some(TraceValue::Object(entries)) => TraceValue::Object(entries.clone()),
        Some(TraceValue::Array(items)) => TraceValue::Object(
            items
                .iter()
                .enumerate()
                .map(|(i, x)| (i.to_string(), x.clone()))
                .collect(),
        ),
        Some(TraceValue::Text(t)) => TraceValue::Object(
            t.as_units()
                .iter()
                .enumerate()
                .map(|(i, u)| {
                    (
                        i.to_string(),
                        TraceValue::Text(JsText::from_units(vec![*u])),
                    )
                })
                .collect(),
        ),
        _ => TraceValue::Object(Vec::new()),
    }
}

fn write_json(out: &mut String, v: &TraceValue, top: bool) {
    match v {
        TraceValue::Undefined => out.push_str(if top { "undefined" } else { "null" }),
        TraceValue::Null => out.push_str("null"),
        TraceValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        TraceValue::Num(n) => {
            if n.is_finite() {
                out.push_str(&num_to_string(*n));
            } else {
                out.push_str("null");
            }
        }
        TraceValue::Text(t) => out.push_str(&t.js_stringify()),
        TraceValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(out, item, false);
            }
            out.push(']');
        }
        TraceValue::Object(entries) => {
            out.push('{');
            let mut first = true;
            for (k, val) in entries {
                if matches!(val, TraceValue::Undefined) {
                    continue; // JSON.stringify omite chaves undefined
                }
                if !first {
                    out.push(',');
                }
                first = false;
                out.push_str(&JsText::from_str(k).js_stringify());
                out.push(':');
                write_json(out, val, false);
            }
            out.push('}');
        }
    }
}

/// `String(n)` do JS para os números do ledger (inteiros, ±Infinity e NaN).
fn num_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return (if n > 0.0 { "Infinity" } else { "-Infinity" }).to_string();
    }
    if n == 0.0 {
        return "0".to_string();
    }
    if n.fract() == 0.0 && n.abs() < 1e15 {
        return (n as i64).to_string();
    }
    n.to_string()
}
