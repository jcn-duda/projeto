//! Porte de `src/utils/metric-id.ts`: `safeMetricId` e
//! `indexerFallbackMetricKey`.
//!
//! `safeMetricId` normaliza um valor de TERCEIRO (nome de indexer/adapter vindo
//! de config ou do catálogo) no id de métrica `fallback.indexer.<id>`. É a
//! fonte ÚNICA da regra: o produtor do contador e o consumidor do painel
//! precisam montar a MESMA chave, então qualquer divergência aqui mostraria o
//! indicador zerado para sempre.
//!
//! A cadeia do TS é
//! `String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g,'_').slice(0,40)`
//! e cada passo tem uma pegadinha:
//!
//! - `value || ''` usa a FALSIDADE do JS: `undefined`, `null`, `""`, `0` e
//!   `false` viram `''` (e daí `unknown`). `[]` é TRUTHY e `String([])` é `''`
//!   (logo `unknown`), enquanto `{}` vira `[object Object]`. A coerção de texto
//!   vem de `js_text` (`js_to_string`) e a falsidade é o `js_truthy` local, com
//!   a mesma semântica dos outros portes.
//! - `trim`/`toLowerCase` usam `js_trim` e `str::to_lowercase` (Unicode 17.0.0,
//!   o MESMO do Node do oráculo — por isso a toolchain é pinada em 1.92.0).
//! - `replace(/[^a-z0-9_.-]/g,'_')` NÃO tem a flag `/u`: opera por UNIDADE
//!   UTF-16, não por ponto de código. Um par astral (ex.: `😀` = `D83D DE00`)
//!   vira DOIS `_`. Iterar por `char` produziria um único `_` e quebraria a
//!   paridade; por isso a substituição percorre `encode_utf16`. Como o alfabeto
//!   permitido é ASCII, o resultado já é ASCII puro.
//! - `slice(0, 40)` corta em unidades UTF-16, mas o texto já é ASCII depois do
//!   `replace`, então o corte é trivial (unidades = chars = bytes).

use serde_json::Value;

use crate::js_text::{js_to_string, js_trim};

/// `safeMetricId`: id de métrica seguro para um valor de terceiro.
///
/// Falsy (`undefined`, `null`, `""`, `0`, `false`) e o que normaliza para
/// vazio viram `unknown`. `[]` (truthy) também cai em `unknown`; `{}` vira
/// `_object_object_`.
pub fn safe_metric_id(value: &Value) -> String {
    let coerced = if js_truthy(value) {
        js_to_string(value)
    } else {
        String::new()
    };
    let lowered = js_trim(&coerced).to_lowercase();
    // `replace` por UNIDADE UTF-16: o par astral vira dois `_`.
    let replaced: String = lowered.encode_utf16().map(unit_to_ascii).collect();
    // `slice(0, 40)`: pós-`replace` o texto é ASCII, então 40 unidades = 40 chars.
    let clean: String = replaced.chars().take(40).collect();
    if clean.is_empty() {
        "unknown".to_string()
    } else {
        clean
    }
}

/// `indexerFallbackMetricKey`: chave do contador de cobertura do banco vivo.
/// Produtor e consumidor compartilham ESTA função (`Bank Test/ID` →
/// `fallback.indexer.bank_test_id`).
pub fn indexer_fallback_metric_key(indexer_id: &Value) -> String {
    format!("fallback.indexer.{}", safe_metric_id(indexer_id))
}

/// Unidade UTF-16 permitida pelo regex do TS: `[a-z0-9_.-]`; o resto vira `_`.
fn unit_to_ascii(unit: u16) -> char {
    match unit {
        0x61..=0x7A | 0x30..=0x39 | 0x5F | 0x2E | 0x2D => unit as u8 as char,
        _ => '_',
    }
}

/// Falsidade do JS (`value || ''`) sobre um valor JSON.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        // `0`, `-0` e `NaN` são falsy; não há NaN vindo de JSON, e um inteiro
        // fora do range de f64 segue truthy (não é zero).
        Value::Number(n) => n.as_f64().is_none_or(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        // `[]` e `{}` são truthy no JS (arrays/objetos nunca são falsy).
        Value::Array(_) | Value::Object(_) => true,
    }
}
