//! Codec do progresso de série parcial (`SeriesWorkProgress`): parse validado,
//! render canônico e a decisão "avançou × estagnou". É a fatia do
//! `crawl-store-rules.ts` que evita reler a mesma página de série do zero e que
//! detecta estagnação (`series_stall`) comparando a forma canônica.
//!
//! `parseProgress` e `renderProgress` NÃO são simétricos de propósito:
//! - o parseaceita qualquer objeto com `v === 1` e array `doneCards`, normaliza
//!   o `card` e PRESERVA negativos/floats em `totalCards`;
//! - o render exige `card.url` TRUTHY, faz `trunc`+`max(0,...)` em `skip` e
//!   `totalCards`, e inclui `seen` quando o array CRU não está vazio (mesmo que
//!   depois a filtragem o esvazie);
//! - `progressAdvanced` usa o `next` OBJETO como veio (sem normalizar), e
//!   compara ignorando `dry` e `seen` (metadados do passe, não leitura de card).

use serde_json::{Map, Value};

use crate::js_text::{js_number, js_stringify, js_to_string};

use super::{array_strings_filtered, js_truthy, num, or_zero, trunc_max0, truthy_string};

/// `String(raw ?? '')` antes do parse: `null`/ausente viram `''`; um OBJETO crú
/// vira `"[object Object]"` (e falha o parse — nunca é adotado como verdade).
fn coalesced_text(raw: &Value) -> String {
    if raw.is_null() {
        String::new()
    } else {
        js_to_string(raw)
    }
}

/// `card` do `parseProgress`: exige objeto/array truthy com `url` truthy; `skip`
/// é `Number(...) || 0` SEM truncar/clampar (diferente do render).
fn parse_card(p: &Value) -> Option<Value> {
    let c = p.get("card")?;
    let url = truthy_string(c.get("url"));
    if url.is_empty() {
        return None;
    }
    let mut m = Map::new();
    m.insert("url".to_string(), Value::String(url));
    m.insert(
        "skip".to_string(),
        num(or_zero(js_number(c.get("skip").unwrap_or(&Value::Null)))),
    );
    Some(Value::Object(m))
}

/// `parseProgress(raw)` — `null` para JSON ilegível/fora de forma; nunca lança.
pub fn parse_progress(raw: &Value) -> Option<Value> {
    let coalesced = coalesced_text(raw);
    let text = crate::js_text::js_trim(&coalesced);
    if text.is_empty() {
        return None;
    }
    let p: Value = serde_json::from_str(text).ok()?;
    if !p.is_object() {
        return None;
    }
    if p.get("v").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    if !p.get("doneCards").map(Value::is_array).unwrap_or(false) {
        return None;
    }
    let mut m = Map::new();
    m.insert("v".to_string(), num(1.0));
    m.insert(
        "doneCards".to_string(),
        Value::Array(array_strings_filtered(p.get("doneCards"))),
    );
    if let Some(card) = parse_card(&p) {
        m.insert("card".to_string(), card);
    }
    m.insert(
        "totalCards".to_string(),
        num(or_zero(js_number(
            p.get("totalCards").unwrap_or(&Value::Null),
        ))),
    );
    let seen = array_strings_filtered(p.get("seen"));
    if !seen.is_empty() {
        m.insert("seen".to_string(), Value::Array(seen));
    }
    if p.get("dry").and_then(Value::as_f64) == Some(1.0) {
        m.insert("dry".to_string(), num(1.0));
    }
    Some(Value::Object(m))
}

/// `card` do `renderProgress`: exige `p.card.url` truthy; `skip` é
/// `max(0, trunc(Number(...) || 0))`.
fn render_card(p: &Value) -> Option<Value> {
    let c = p.get("card")?;
    let url_v = c.get("url")?;
    if !js_truthy(url_v) {
        return None;
    }
    let mut m = Map::new();
    m.insert("url".to_string(), Value::String(js_to_string(url_v)));
    let skip = trunc_max0(or_zero(js_number(c.get("skip").unwrap_or(&Value::Null))));
    m.insert("skip".to_string(), num(skip));
    Some(Value::Object(m))
}

/// `renderProgress(p)` — serialização canônica com ordem de chaves FIXA
/// (`v`, `doneCards`, `card`, `totalCards`, `seen`, `dry`); a comparação de
/// avanço é textual e só é honesta com forma estável.
pub fn render_progress(p: &Value) -> String {
    let mut m = Map::new();
    m.insert("v".to_string(), num(1.0));
    m.insert(
        "doneCards".to_string(),
        Value::Array(array_strings_filtered(p.get("doneCards"))),
    );
    if let Some(card) = render_card(p) {
        m.insert("card".to_string(), card);
    }
    m.insert(
        "totalCards".to_string(),
        num(trunc_max0(or_zero(js_number(
            p.get("totalCards").unwrap_or(&Value::Null),
        )))),
    );
    if let Some(seen) = p.get("seen").and_then(Value::as_array) {
        if !seen.is_empty() {
            m.insert(
                "seen".to_string(),
                Value::Array(array_strings_filtered(p.get("seen"))),
            );
        }
    }
    if p.get("dry").and_then(Value::as_f64) == Some(1.0) {
        m.insert("dry".to_string(), num(1.0));
    }
    js_stringify(&Value::Object(m))
}

/// Remove `dry` e `seen` de um progresso (metadados que NÃO contam como avanço).
fn strip_dry_seen(v: &Value) -> Value {
    match v {
        Value::Object(map) => {
            let mut m = map.clone();
            m.shift_remove("dry");
            m.shift_remove("seen");
            Value::Object(m)
        }
        outra => outra.clone(),
    }
}

/// `progressAdvanced(prevRaw, next)`:
/// - `next` inválido/ausente → `false` (nunca vira `done` por comparação vazia);
/// - `prev` não parseia → `true` (1ª marcação);
/// - senão, compara a forma canônica SEM `dry`/`seen`.
pub fn progress_advanced(prev: &Value, next: &Value) -> bool {
    let parsed_next = if next.is_string() {
        parse_progress(next)
    } else if next.is_object() || next.is_array() {
        Some(next.clone())
    } else {
        None
    };
    let Some(next_p) = parsed_next else {
        return false;
    };
    let Some(prev_p) = parse_progress(prev) else {
        return true;
    };
    render_progress(&strip_dry_seen(&prev_p)) != render_progress(&strip_dry_seen(&next_p))
}

/// `withDryFlag(raw)` — `renderProgress({ ...parseProgress(raw), dry: 1 })`.
/// O flag é sobre a forma CANÔNICA: reusa `render_progress` (ordem de chaves
/// fixa, `trunc`+`max(0)` em `card.skip`/`totalCards`, arrays filtrados) e não
/// devolve o objeto parseado cru — senão negativos/floats sobreviveriam ao
/// re-render, diferente do TS. Cru ilegível → `''`.
pub fn with_dry_flag(raw: &Value) -> String {
    let Some(p) = parse_progress(raw) else {
        return String::new();
    };
    let mut m = p.as_object().cloned().unwrap_or_default();
    m.insert("dry".to_string(), num(1.0));
    render_progress(&Value::Object(m))
}
