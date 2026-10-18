//! O ledger observacional da busca — formato do `/stream-trace.json`.
//!
//! O corpo do ledger é do NÚCLEO (`adom_core::stream_trace`): nada de régua
//! nova aqui. Este módulo só:
//!
//! 1. cria o trace da busca (`create_stream_trace` com o relógio injetado);
//! 2. transforma o FUNIL do build em etapas (`stages`) — os nomes são os do
//!    construtor/TS (`raw`, `afterSort`, `notice`, `final`…);
//! 3. finaliza (`finalize_trace`) e serializa (`serialize_trace`) no MESMO
//!    shape que o Node grava sob `streams:v21` e que a rota
//!    `/stream-trace.json` devolve;
//! 4. oferece o envelope `{input, etapas, resposta}` — o que o golden precisa
//!    para reproduzir uma busca: a entrada, as etapas e o fato da resposta.
//!
//! Fronteira conhecida: `serialize_trace` pode deixar unidade surrogate ÓRFÃ
//! num rótulo (corte em UTF-16), e o `String` do `serde_json` é UTF-8. A
//! conversão para `Value` troca o órfão por `U+FFFD` — o mesmo limite já
//! documentado para a travessia napi (AGENTS.md). A forma do JSON não muda.

use std::collections::BTreeMap;

use adom_core::{
    create_stream_trace, finalize_trace, serialize_trace, set_trace_stage, TraceValue,
};
use serde_json::Value;

/// Entrada da busca no envelope do trace (o que a rota não tem offline).
#[derive(Debug, Clone)]
pub struct TraceInput {
    pub kind: String,
    pub id: String,
    pub query: String,
    pub names: Vec<String>,
    pub year: String,
    /// A passada que gerou este trace é parcial?
    pub partial: bool,
}

/// Fato da RESPOSTA (o que o cliente recebeu), no envelope.
#[derive(Debug, Clone, Copy)]
pub struct TraceResponseFacts {
    pub streams: usize,
    pub partial: bool,
    pub debrid_known: bool,
    pub cache_max_age: u32,
}

/// `{input, etapas, resposta}` — envelope do golden. `trace` é o ledger já
/// serializado (`/stream-trace.json`); `etapas` é o `stages` dele.
#[derive(Debug, Clone)]
pub struct TraceRecord {
    pub input: TraceValue,
    pub trace: TraceValue,
    pub response: TraceValue,
}

impl TraceRecord {
    pub fn build(input: &TraceInput, trace: TraceValue, response: TraceResponseFacts) -> Self {
        let input_value = TraceValue::Object(vec![
            ("type".into(), TraceValue::text(&input.kind)),
            ("id".into(), TraceValue::text(&input.id)),
            ("query".into(), TraceValue::text(&input.query)),
            (
                "names".into(),
                TraceValue::Array(input.names.iter().map(|n| TraceValue::text(n)).collect()),
            ),
            ("year".into(), TraceValue::text(&input.year)),
            ("partial".into(), TraceValue::Bool(input.partial)),
        ]);
        let response_value = TraceValue::Object(vec![
            ("streams".into(), TraceValue::Num(response.streams as f64)),
            ("partial".into(), TraceValue::Bool(response.partial)),
            (
                "debridKnown".into(),
                TraceValue::Bool(response.debrid_known),
            ),
            (
                "cacheMaxAge".into(),
                TraceValue::Num(f64::from(response.cache_max_age)),
            ),
        ]);
        TraceRecord {
            input: input_value,
            trace,
            response: response_value,
        }
    }

    /// `stages` do ledger (`etapas`), quando o trace serializado é objeto.
    pub fn etapas(&self) -> Option<&TraceValue> {
        self.trace.get("stages")
    }

    /// JSON do envelope (`JSON.stringify` do JS, com o órfão escapado).
    pub fn to_json_string(&self) -> String {
        TraceValue::Object(vec![
            ("input".into(), self.input.clone()),
            (
                "etapas".into(),
                self.etapas()
                    .cloned()
                    .unwrap_or(TraceValue::Object(Vec::new())),
            ),
            ("resposta".into(), self.response.clone()),
        ])
        .js_stringify()
    }

    /// Envelope como `Value`. `None` só se o JSON do núcleo não for parseável
    /// (não acontece: `js_stringify` emite JSON válido; o órfão é sanado).
    pub fn to_json_value(&self) -> Option<Value> {
        serde_json::from_str(&self.to_json_string()).ok()
    }
}

/// Trace novo da busca. `None` com o kill-switch desligado (captura desligada,
/// como no TS — a leitura também para).
pub fn new_trace(now_ms: f64, enabled: bool) -> Option<TraceValue> {
    enabled.then(|| create_stream_trace(now_ms))
}

/// Funil do build → `stages` do ledger, na ordem do `BTreeMap` (determinística).
/// `set_trace_stage` FIXA o valor (mesmo zero); a contagem é sempre a desta
/// build, nunca acumulada com a de outra.
pub fn record_build_stages(trace: &mut Option<TraceValue>, funnel: &BTreeMap<String, usize>) {
    let Some(trace) = trace.as_mut() else { return };
    for (stage, count) in funnel {
        set_trace_stage(
            Some(trace),
            &TraceValue::text(stage),
            &TraceValue::Num(*count as f64),
        );
    }
}

/// Fecha o ledger: `finishedAt` + estágio `final` com o tamanho ENTREGUE.
pub fn finish_trace(trace: &mut Option<TraceValue>, final_count: usize, now_ms: f64) {
    if let Some(trace) = trace.as_mut() {
        finalize_trace(Some(trace), &TraceValue::Num(final_count as f64), now_ms);
    }
}

/// Ledger serializado → valor do cache (o campo `trace` do `streams:v21`).
/// `js_stringify` + parse: preserva a forma exata do Node; `undefined`/NaN
/// seguem a regra do `JSON.stringify` (chave omitida / `null`).
pub fn trace_to_cache_value(trace: Option<&TraceValue>) -> Option<Value> {
    let trace = serialize_trace(trace, true)?;
    let text = sanitize_lone_surrogates(&trace.js_stringify());
    serde_json::from_str(&text).ok()
}

/// `\ud800`–`\udfff` sozinhos não viram UTF-8. Troca o escape por `\ufffd`
/// (o mesmo U+FFFD que a travessia napi produziria) — sem partir o par válido,
/// que o `js_stringify` já emite como o caractere astral.
fn sanitize_lone_surrogates(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        // Um escape de surrogate é `\uD800`..`\uDFFF` (6 bytes, hex minúsculo).
        if bytes[i] == b'\\'
            && bytes.get(i + 1) == Some(&b'u')
            && i + 6 <= bytes.len()
            && bytes[i + 2..i + 6].iter().all(|b| b.is_ascii_hexdigit())
        {
            let hex = std::str::from_utf8(&bytes[i + 2..i + 6]).unwrap_or("0000");
            if let Ok(value) = u16::from_str_radix(hex, 16) {
                if (0xD800..=0xDFFF).contains(&value) {
                    out.push_str("\\ufffd");
                    i += 6;
                    continue;
                }
            }
        }
        // Byte a byte até achar `\\` de novo: o restante é UTF-8 válido.
        let ch = text[i..].chars().next().expect("fronteira de char");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_tem_input_etapas_e_resposta() {
        let mut trace = new_trace(1000.0, true);
        let mut funnel = BTreeMap::new();
        funnel.insert("raw".to_string(), 7);
        funnel.insert("final".to_string(), 2);
        record_build_stages(&mut trace, &funnel);
        finish_trace(&mut trace, 2, 1200.0);
        let serialized = serialize_trace(trace.as_ref(), true).expect("serializado");

        let record = TraceRecord::build(
            &TraceInput {
                kind: "movie".into(),
                id: "tt1".into(),
                query: "Matrix 1999".into(),
                names: vec!["Matrix".into()],
                year: "1999".into(),
                partial: true,
            },
            serialized,
            TraceResponseFacts {
                streams: 2,
                partial: true,
                debrid_known: false,
                cache_max_age: 0,
            },
        );
        let value = record.to_json_value().expect("envelope JSON");
        assert_eq!(value["input"]["type"], "movie");
        assert_eq!(value["input"]["query"], "Matrix 1999");
        assert_eq!(value["etapas"]["raw"], 7);
        assert_eq!(value["etapas"]["final"], 2);
        assert_eq!(value["resposta"]["streams"], 2);
        assert_eq!(value["resposta"]["cacheMaxAge"], 0);
        // O ledger serializado mantém a forma do Node.
        assert_eq!(
            record.trace.get("startedAt").cloned(),
            Some(TraceValue::Num(1000.0))
        );
        assert_eq!(
            record.trace.get("finishedAt").cloned(),
            Some(TraceValue::Num(1200.0))
        );
    }

    #[test]
    fn kill_switch_desliga_captura_e_serializacao() {
        assert!(new_trace(1.0, false).is_none());
        assert!(trace_to_cache_value(None).is_none());
    }

    #[test]
    fn orfao_vira_fffd_sem_quebrar_o_json() {
        let text = r#"{"label":"a\ud83db"}"#;
        let clean = sanitize_lone_surrogates(text);
        assert!(!clean.contains("\\ud83d"), "{clean}");
        let parsed: Value = serde_json::from_str(&clean).expect("JSON válido");
        assert_eq!(parsed["label"], "a\u{FFFD}b");
        // Par válido não é escape no js_stringify; sanitizar não o toca.
        assert_eq!(sanitize_lone_surrogates(r#"{"x":"😀"}"#), r#"{"x":"😀"}"#);
    }
}
