//! Porte de `src/utils/stream-trace.ts` — o ledger observacional do pipeline de
//! busca (P5). Cada corte que uma release sofre entre o raw e a lista final fica
//! registrado e viaja DENTRO da entrada `streams` do cache, o que permite ao
//! `/stream-trace.json` responder offline, sem refazer a busca.
//!
//! Duas adaptações tornam o módulo PURO: o relógio entra por parâmetro (`now_ms`
//! no lugar de `Date.now()`) e o kill-switch entra como `enabled: bool` (no lugar
//! de ler `config.search.streamTrace`). Nada de rede, timer ou estado de módulo.
//! `label`/`chupim` são cortados em UNIDADES UTF-16 e podem deixar surrogate
//! órfão: por isso são [`JsText`] e a comparação do golden usa o `js_stringify`.
//!
//! Regra de ouro: `trace` null/undefined em QUALQUER função => nada acontece.

mod value;

pub use self::value::TraceValue;
use self::value::{js_text_to_string, spread_object};

use crate::js_text16::JsText;

/// Teto geral de detalhe (a busca fria pode arrastar centenas de itens crus).
pub const STREAM_TRACE_MAX_ITEMS: usize = 300;
/// Teto PRÓPRIO dos cortes `account-*` dentro do teto geral (detalhe por item).
pub const STREAM_TRACE_MAX_ACCOUNT_ITEMS: usize = 60;
/// Rótulo é título de release; 60 unidades bastam para identificar o post.
pub const STREAM_TRACE_LABEL_MAX: usize = 60;
/// Resumo do Chupim (tokens de enum); teto folgado mas curto.
pub const STREAM_TRACE_CHUPIM_MAX: usize = 160;

/// `createStreamTrace()`: nasce vazio, `startedAt` do relógio injetado.
pub fn create_stream_trace(now_ms: f64) -> TraceValue {
    TraceValue::Object(vec![
        ("stages".to_string(), TraceValue::Object(Vec::new())),
        ("items".to_string(), TraceValue::Array(Vec::new())),
        ("accountItems".to_string(), TraceValue::Num(0.0)),
        ("startedAt".to_string(), TraceValue::Num(now_ms)),
        ("finishedAt".to_string(), TraceValue::Null),
        ("chupim".to_string(), TraceValue::Null),
    ])
}

/// `cloneStreamTrace`: RECONSTRÓI a forma fixa do TS
/// (`src/utils/stream-trace.ts:135-142`) na MESMA ordem — `stages`, `items`,
/// `accountItems`, `startedAt`, `finishedAt`, `chupim` — descartando chaves
/// extras e fixando a ordem (NÃO é `source.clone()` + `set_key`, que preservaria
/// extras/ordem). `stages` é `{ ...source.stages }` e cada item é `{ ...item }`
/// (objetos NOVOS); `finishedAt` sempre reseta a `null` e `chupim` é `?? null`.
/// Falsy => null. Campo ausente vira `undefined` no objeto (o `js_stringify`
/// omite a chave, como o `JSON.stringify`).
pub fn clone_stream_trace(source: Option<&TraceValue>) -> Option<TraceValue> {
    let source = source?;
    if !source.truthy() {
        return None;
    }
    let stages = spread_object(source.get("stages"));
    let items = match source.get("items") {
        Some(TraceValue::Array(list)) => {
            TraceValue::Array(list.iter().map(|v| spread_object(Some(v))).collect())
        }
        _ => TraceValue::Array(Vec::new()),
    };
    let account = source
        .get("accountItems")
        .cloned()
        .unwrap_or(TraceValue::Undefined);
    let started = source
        .get("startedAt")
        .cloned()
        .unwrap_or(TraceValue::Undefined);
    let chupim = match source.get("chupim") {
        Some(v) if !matches!(v, TraceValue::Undefined | TraceValue::Null) => v.clone(),
        _ => TraceValue::Null,
    };
    Some(TraceValue::Object(vec![
        ("stages".to_string(), stages),
        ("items".to_string(), items),
        ("accountItems".to_string(), account),
        ("startedAt".to_string(), started),
        ("finishedAt".to_string(), TraceValue::Null),
        ("chupim".to_string(), chupim),
    ]))
}

/// `stageTrace`: soma `Math.trunc(count)`. `count` precisa ser NÚMERO finito e
/// positivo (`Number.isFinite` NÃO coage string) e o estágio não pode ser vazio.
pub fn stage_trace(t: Option<&mut TraceValue>, stage: &TraceValue, count: &TraceValue) {
    let Some(t) = t else { return };
    if !stage.truthy() {
        return;
    }
    let n = match count {
        TraceValue::Num(n) if n.is_finite() => *n,
        _ => return,
    };
    if n <= 0.0 {
        return;
    }
    let key = js_text_to_string(&stage.to_text());
    if let Some(stages) = t.get_mut("stages") {
        let base = match stages.get(&key) {
            Some(v) if v.truthy() => v.number(),
            _ => 0.0,
        };
        stages.set_key(&key, TraceValue::Num(base + n.trunc()));
    }
}

/// `setTraceStage`: FIXA o estágio mesmo em zero. `count` finito >= 0.
pub fn set_trace_stage(t: Option<&mut TraceValue>, stage: &TraceValue, count: &TraceValue) {
    let Some(t) = t else { return };
    if !stage.truthy() {
        return;
    }
    let n = match count {
        TraceValue::Num(n) if n.is_finite() => *n,
        _ => return,
    };
    if n < 0.0 {
        return;
    }
    let key = js_text_to_string(&stage.to_text());
    if let Some(stages) = t.get_mut("stages") {
        stages.set_key(&key, TraceValue::Num(n.trunc()));
    }
}

/// `finalizeTrace`: fecha o instante e fixa `final` (o tamanho ENTREGUE,
/// sobrepondo o provisório). `Number(x) || 0` coagido, truncado, piso em 0.
pub fn finalize_trace(t: Option<&mut TraceValue>, final_count: &TraceValue, now_ms: f64) {
    let Some(t) = t else { return };
    t.set_key("finishedAt", TraceValue::Num(now_ms));
    let n = final_count.number();
    let m = if n.is_nan() || n == 0.0 { 0.0 } else { n };
    if let Some(stages) = t.get_mut("stages") {
        stages.set_key("final", TraceValue::Num(m.trunc().max(0.0)));
    }
}

/// `dropTrace`: registra UM item cortado com id sintético ("s1", ...); NUNCA copia
/// `infoHash`. Os dois tetos são checados antes de qualquer escrita.
pub fn drop_trace(t: Option<&mut TraceValue>, item: &TraceValue, reason: &TraceValue) {
    let Some(t) = t else { return };
    let len = match t.get("items") {
        Some(TraceValue::Array(items)) => items.len(),
        _ => 0,
    };
    if len >= STREAM_TRACE_MAX_ITEMS {
        return;
    }
    let is_account = js_text_to_string(&reason.to_text()).starts_with("account-");
    let account = match t.get("accountItems") {
        Some(TraceValue::Num(n)) => *n,
        _ => 0.0,
    };
    if is_account && account >= STREAM_TRACE_MAX_ACCOUNT_ITEMS as f64 {
        return;
    }
    let mut entry = vec![
        ("id".to_string(), TraceValue::text(&format!("s{}", len + 1))),
        ("reason".to_string(), reason.clone()),
        ("label".to_string(), TraceValue::Text(label_of(item))),
        ("br".to_string(), TraceValue::Bool(br_flag(item).truthy())),
    ];
    match item.get("_dubbed") {
        Some(TraceValue::Undefined) | None => {}
        Some(v) => entry.push(("dubbed".to_string(), TraceValue::Bool(v.truthy()))),
    }
    match item.get("_quality") {
        Some(v) if v.truthy() => {
            entry.push(("quality".to_string(), TraceValue::Text(v.to_text())));
        }
        _ => {}
    }
    if let Some(TraceValue::Array(items)) = t.get_mut("items") {
        items.push(TraceValue::Object(entry));
    }
    if is_account {
        t.set_key("accountItems", TraceValue::Num(account + 1.0));
    }
}

/// `raw._br ?? raw.isBr` (nullish, não truthy): `false` presente vence.
fn br_flag(item: &TraceValue) -> TraceValue {
    match item.get("_br") {
        Some(v) if !matches!(v, TraceValue::Undefined | TraceValue::Null) => v.clone(),
        _ => item.get("isBr").cloned().unwrap_or(TraceValue::Undefined),
    }
}

/// `String(it?.title || it?.Title || it?.name || '').split('\n')[0]`.
fn label_of(item: &TraceValue) -> JsText {
    let chosen = ["title", "Title", "name"]
        .iter()
        .find_map(|k| item.get(k).filter(|v| v.truthy()).map(|v| v.to_text()));
    let text = chosen.unwrap_or_default();
    let units: Vec<u16> = text
        .as_units()
        .iter()
        .take_while(|u| **u != 0x0A)
        .copied()
        .collect();
    JsText::from_units(units)
}

/// `setTraceChupim`: last-writer do resumo; no-op com o kill-switch desligado (a
/// captura também desliga, não só a leitura).
pub fn set_trace_chupim(t: Option<&mut TraceValue>, note: &TraceValue, enabled: bool) {
    if !enabled {
        return;
    }
    let Some(t) = t else { return };
    t.set_key("chupim", TraceValue::Text(sanitize_chupim_note(note)));
}

/// `sanitizeTraceLabel`: única porta de saída de rótulos (trace E recompute).
pub fn sanitize_trace_label(label: &TraceValue) -> JsText {
    truncate_ellipsis(redact(clean_text(label)), STREAM_TRACE_LABEL_MAX)
}

/// `sanitizeChupimNote`: mesma higiene do rótulo, teto de 160 unidades.
pub fn sanitize_chupim_note(note: &TraceValue) -> JsText {
    truncate_ellipsis(redact(clean_text(note)), STREAM_TRACE_CHUPIM_MAX)
}

/// `String(v || '')` antes de qualquer regex (falsy vira vazio).
fn clean_text(v: &TraceValue) -> JsText {
    if v.truthy() {
        v.to_text()
    } else {
        JsText::default()
    }
}

/// `clean.length > max ? clean.slice(0, max-1) + '…' : clean` (unidades UTF-16,
/// então a fronteira PODE partir um par e deixar o órfão).
fn truncate_ellipsis(t: JsText, max: usize) -> JsText {
    if t.units() > max {
        let mut cut = t.js_slice(max - 1);
        cut.push_str("…");
        cut
    } else {
        t
    }
}

/// `/magnet:\?\S*/gi` e depois `/[a-fA-F0-9]{40}/g`: a ordem importa (o magnet
/// consome a URI inteira, inclusive `dn=`, antes do hash solto).
fn redact(input: JsText) -> JsText {
    JsText::from_units(redact_hash(&redact_magnet(input.as_units())))
}

fn redact_magnet(src: &[u16]) -> Vec<u16> {
    let tag: Vec<u16> = "magnet:?".encode_utf16().collect();
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        if i + tag.len() <= src.len() && (0..tag.len()).all(|k| eq_ascii_ci(src[i + k], tag[k])) {
            i += tag.len();
            while i < src.len() && !is_js_space_unit(src[i]) {
                i += 1;
            }
            out.extend("<magnet>".encode_utf16());
        } else {
            out.push(src[i]);
            i += 1;
        }
    }
    out
}

fn redact_hash(src: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        if is_hex_unit(src[i]) {
            let start = i;
            while i < src.len() && is_hex_unit(src[i]) {
                i += 1;
            }
            let run = i - start;
            for _ in 0..run / 40 {
                out.extend("<hash>".encode_utf16());
            }
            out.extend_from_slice(&src[i - (run % 40)..i]);
        } else {
            out.push(src[i]);
            i += 1;
        }
    }
    out
}

fn eq_ascii_ci(a: u16, b: u16) -> bool {
    let lo = if (b'A' as u16..=b'Z' as u16).contains(&a) {
        a + 32
    } else {
        a
    };
    lo == b
}

fn is_hex_unit(u: u16) -> bool {
    matches!(u, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66)
}

/// `\s` do ECMAScript (o `\s` do crate não inclui o BOM).
fn is_js_space_unit(u: u16) -> bool {
    matches!(
        u,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0x00A0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

/// `serializeTrace`: payload seguro para o cache/endpoint. `None` sem trace ou com
/// o kill-switch desligado. Idempotente: o payload gravado volta a passar aqui.
pub fn serialize_trace(t: Option<&TraceValue>, enabled: bool) -> Option<TraceValue> {
    if !enabled {
        return None;
    }
    let t = t?;
    if !t.truthy() {
        return None;
    }
    let mut stages: Vec<(String, TraceValue)> = Vec::new();
    if let Some(TraceValue::Object(entries)) = t.get("stages") {
        for (k, v) in entries {
            // `stages[k]=n` num objeto comum: `__proto__` vira protótipo (não cria
            // campo); as demais entram na ordem de iteração.
            if k == "__proto__" {
                continue;
            }
            let n = v.number();
            if n.is_finite() {
                stages.push((k.clone(), TraceValue::Num(n)));
            }
        }
    }
    let mut items: Vec<TraceValue> = Vec::new();
    if let Some(TraceValue::Array(list)) = t.get("items") {
        for (index, item) in list.iter().take(STREAM_TRACE_MAX_ITEMS).enumerate() {
            items.push(spread_item(item, index));
        }
    }
    let started = match t.get("startedAt") {
        Some(v) => {
            let n = v.number();
            if n.is_nan() || n == 0.0 {
                0.0
            } else {
                n
            }
        }
        None => 0.0,
    };
    let finished = match t.get("finishedAt") {
        Some(TraceValue::Num(n)) => TraceValue::Num(*n),
        _ => TraceValue::Null,
    };
    let mut out = vec![
        ("stages".to_string(), TraceValue::Object(stages)),
        ("items".to_string(), TraceValue::Array(items)),
        ("startedAt".to_string(), TraceValue::Num(started)),
        ("finishedAt".to_string(), finished),
    ];
    if let Some(v) = t.get("chupim").filter(|v| v.truthy()) {
        out.push((
            "chupim".to_string(),
            TraceValue::Text(sanitize_chupim_note(v)),
        ));
    }
    Some(TraceValue::Object(out))
}

/// `{...item, id, label, br}`: o spread preserva os campos extra e a ORDEM; `id`
/// (ou `s{n}`), `label` sanitizado e `br` booleano sobrescrevem in place.
fn spread_item(item: &TraceValue, index: usize) -> TraceValue {
    let mut out = TraceValue::Object(match item {
        TraceValue::Object(e) => e.clone(),
        _ => Vec::new(),
    });
    let id = match item.get("id") {
        Some(v) if v.truthy() => v.clone(),
        _ => TraceValue::text(&format!("s{}", index + 1)),
    };
    out.set_key("id", id);
    let label = match item.get("label") {
        Some(v) if v.truthy() => v.clone(),
        _ => TraceValue::Undefined,
    };
    out.set_key("label", TraceValue::Text(sanitize_trace_label(&label)));
    out.set_key(
        "br",
        TraceValue::Bool(item.get("br").is_some_and(TraceValue::truthy)),
    );
    out
}
