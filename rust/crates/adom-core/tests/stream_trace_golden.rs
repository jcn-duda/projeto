//! Paridade e integridade do golden `stream-trace` (138 casos) do ledger portado
//! em `core/src/stream_trace.rs`.
//!
//! O teste é o DRIVER do corpus commitado (que NÃO é regenerado): expande
//! `repeat`, interpreta as ops com relógio fake por caso e compara o texto
//! renderizado (`js_stringify`; órfão das bordas 59/159 escapado) com `expected`.
//! Quando o capturado é string, a comparação fina usa o decoder tolerante.

mod common;

use std::collections::{HashMap, HashSet};

use adom_core::{
    clone_stream_trace, create_stream_trace, drop_trace, finalize_trace, sanitize_trace_label,
    serialize_trace, set_trace_chupim, set_trace_stage, stage_trace, JsText, TraceValue,
    MANIFEST_FORMAT, STREAM_TRACE_CHUPIM_MAX, STREAM_TRACE_LABEL_MAX,
    STREAM_TRACE_MAX_ACCOUNT_ITEMS, STREAM_TRACE_MAX_ITEMS,
};
use serde::Deserialize;
use serde_json::Value;

use common::{jsonl_lines, manifest, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/stream-trace.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/stream-trace.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-stream-trace.json");

const REGISTRY: [&str; 9] = [
    "stream-trace/create",
    "stream-trace/clone",
    "stream-trace/stage",
    "stream-trace/setStage",
    "stream-trace/drop",
    "stream-trace/finalize",
    "stream-trace/setChupim",
    "stream-trace/sanitizeLabel",
    "stream-trace/serialize",
];

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    input: Scenario,
    expected: String,
}

#[derive(Debug, Deserialize)]
struct Scenario {
    env: String,
    clock: Clock,
    ops: Vec<Value>,
    capture: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
struct Clock {
    base: f64,
    step: f64,
}

fn parse_cases() -> Vec<Case> {
    jsonl_lines(JSONL_BYTES)
        .iter()
        .map(|line| serde_json::from_str(line).expect("linha do golden precisa ser válida"))
        .collect()
}

/// `decodeTop`: marcadores `{"$": "undef"|"null"|"nan"|"inf"|"-inf"}`.
fn decode(v: &Value) -> TraceValue {
    let tag = match v {
        Value::Object(m) => m.get("$").and_then(Value::as_str),
        _ => None,
    };
    match tag {
        Some("undef") => TraceValue::Undefined,
        Some("null") => TraceValue::Null,
        Some("nan") => TraceValue::Num(f64::NAN),
        Some("inf") => TraceValue::Num(f64::INFINITY),
        Some("-inf") => TraceValue::Num(f64::NEG_INFINITY),
        _ => TraceValue::from_json(v),
    }
}

/// Argumento literal (`decodeTop`); ausente = `undefined`.
fn arg(op: &Value, key: &str) -> TraceValue {
    op.get(key).map(decode).unwrap_or(TraceValue::Undefined)
}

/// Expansão MECÂNICA de `repeat` (só o driver expande; nunca o oráculo).
fn expand(ops: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for op in ops {
        match op.get("repeat").and_then(Value::as_u64) {
            None => out.push(op.clone()),
            Some(n) => {
                let mut base = op.clone();
                if let Value::Object(m) = &mut base {
                    m.remove("repeat");
                }
                for _ in 0..n {
                    out.push(base.clone());
                }
            }
        }
    }
    out
}

fn assign_at(t: &mut TraceValue, keys: &[&str], value: TraceValue) {
    if keys.len() == 1 {
        if let TraceValue::Object(entries) = t {
            match entries.iter_mut().find(|(k, _)| k == keys[0]) {
                Some(slot) => slot.1 = value,
                None => entries.push((keys[0].to_string(), value)),
            }
        }
        return;
    }
    match t {
        TraceValue::Object(entries) => {
            if let Some((_, child)) = entries.iter_mut().find(|(k, _)| k == keys[0]) {
                assign_at(child, &keys[1..], value);
            }
        }
        TraceValue::Array(items) => {
            if let Some(child) = keys[0].parse::<usize>().ok().and_then(|i| items.get_mut(i)) {
                assign_at(child, &keys[1..], value);
            }
        }
        _ => {}
    }
}

struct Env {
    vars: HashMap<String, TraceValue>,
    last: TraceValue,
    clock: Clock,
    calls: f64,
    enabled: bool,
}

impl Env {
    /// Relógio fake: cada leitura soma `step` a partir de `base`.
    fn now(&mut self) -> f64 {
        let v = self.clock.base + self.clock.step * self.calls;
        self.calls += 1.0;
        v
    }

    /// `put`: guarda em `into` (se houver) e atualiza o `$last`.
    fn put(&mut self, op: &Value, val: TraceValue) {
        if let Some(Value::String(name)) = op.get("into") {
            self.vars.insert(name.clone(), val.clone());
        }
        self.last = val;
    }

    /// `refOf`: string é nome de var; demais são literais/marcadores.
    fn ref_arg(&self, op: &Value, key: &str, fallback: &str) -> TraceValue {
        match op.get(key) {
            Some(Value::String(name)) => self
                .vars
                .get(name)
                .cloned()
                .unwrap_or(TraceValue::Undefined),
            Some(v) => decode(v),
            None => self
                .vars
                .get(fallback)
                .cloned()
                .unwrap_or(TraceValue::Undefined),
        }
    }

    /// Resolve o alvo `t` (`op.t ?? 't'`): nome de var + valor, ou literal.
    fn target_spec(&self, op: &Value) -> (Option<String>, TraceValue) {
        match op.get("t") {
            Some(Value::String(n)) => (
                Some(n.clone()),
                self.vars.get(n).cloned().unwrap_or(TraceValue::Undefined),
            ),
            Some(v) => (None, decode(v)),
            None => (
                Some("t".to_string()),
                self.vars.get("t").cloned().unwrap_or(TraceValue::Undefined),
            ),
        }
    }

    /// Alvo mutável: passa `Some(&mut)` só para objeto (falsy => None), grava de
    /// volta e deixa `$last = undefined` (as funções de corte são void).
    fn mutate_target<F: FnOnce(Option<&mut TraceValue>)>(&mut self, op: &Value, f: F) {
        let (name, mut val) = self.target_spec(op);
        let target = if matches!(val, TraceValue::Object(_)) {
            Some(&mut val)
        } else {
            None
        };
        f(target);
        if let Some(n) = name {
            self.vars.insert(n, val);
        }
        self.last = TraceValue::Undefined;
    }

    fn apply(&mut self, op: &Value) {
        match op.get("op").and_then(Value::as_str).unwrap_or("") {
            "create" => {
                let v = create_stream_trace(self.now());
                self.put(op, v);
            }
            "clone" => {
                let src = self.ref_arg(op, "from", "t");
                let v = clone_stream_trace(Some(&src)).unwrap_or(TraceValue::Null);
                self.put(op, v);
            }
            "stage" => {
                let (s, c) = (arg(op, "stage"), arg(op, "count"));
                self.mutate_target(op, |t| stage_trace(t, &s, &c));
            }
            "setStage" => {
                let (s, c) = (arg(op, "stage"), arg(op, "count"));
                self.mutate_target(op, |t| set_trace_stage(t, &s, &c));
            }
            "drop" => {
                let (i, r) = (arg(op, "item"), arg(op, "reason"));
                self.mutate_target(op, |t| drop_trace(t, &i, &r));
            }
            "setChupim" => {
                let note = arg(op, "note");
                let enabled = self.enabled;
                self.mutate_target(op, |t| set_trace_chupim(t, &note, enabled));
            }
            "finalize" => {
                let fc = arg(op, "finalCount");
                let now = self.now();
                self.mutate_target(op, |t| finalize_trace(t, &fc, now));
            }
            "sanitizeLabel" => {
                let label = arg(op, "label");
                self.put(op, TraceValue::Text(sanitize_trace_label(&label)));
            }
            "serialize" => {
                let src = self.ref_arg(op, "t", "t");
                let v = serialize_trace(Some(&src), self.enabled).unwrap_or(TraceValue::Null);
                self.put(op, v);
            }
            "assign" => {
                // Reflection pura do corpus: muta o alvo e grava de volta na var
                // (o oráculo muta o MESMO objeto referenciado).
                let (name, mut target) = self.target_spec(op);
                let path = op
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                assign_at(
                    &mut target,
                    &path.split('.').collect::<Vec<_>>(),
                    arg(op, "value"),
                );
                if let Some(n) = name {
                    self.vars.insert(n, target.clone());
                }
                self.put(op, target);
            }
            other => panic!("op desconhecida: {other}"),
        }
    }
}

fn run_case(sc: &Scenario) -> TraceValue {
    let mut env = Env {
        vars: HashMap::new(),
        last: TraceValue::Undefined,
        clock: sc.clock,
        calls: 0.0,
        enabled: sc.env != "false" && sc.env != "0",
    };
    for op in expand(&sc.ops) {
        env.apply(&op);
    }
    if sc.capture == "$last" {
        return env.last;
    }
    env.vars
        .get(&sc.capture)
        .cloned()
        .unwrap_or(TraceValue::Undefined)
}

fn case<'a>(cases: &'a [Case], id: &str) -> &'a Case {
    cases
        .iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| panic!("caso ausente: {id}"))
}

fn chupim_of(state: &TraceValue) -> &JsText {
    match state {
        TraceValue::Object(entries) => match entries.iter().find(|(k, _)| k == "chupim") {
            Some((_, TraceValue::Text(t))) => t,
            _ => panic!("chupim ausente"),
        },
        _ => panic!("estado não é objeto"),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(
        m.registry,
        REGISTRY.iter().map(|s| s.to_string()).collect::<Vec<_>>()
    );
    assert_eq!(m.output.lines, 138);
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/stream-trace.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-stream-trace.json");
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn tetos_do_contrato() {
    assert_eq!(STREAM_TRACE_MAX_ITEMS, 300);
    assert_eq!(STREAM_TRACE_MAX_ACCOUNT_ITEMS, 60);
    assert_eq!(STREAM_TRACE_LABEL_MAX, 60);
    assert_eq!(STREAM_TRACE_CHUPIM_MAX, 160);
}

#[test]
fn ids_unicos_e_138_casos() {
    let cases = parse_cases();
    assert_eq!(cases.len(), 138);
    let mut ids = HashSet::new();
    for c in &cases {
        assert!(ids.insert(c.id.as_str()), "id duplicado: {}", c.id);
    }
}

#[test]
fn saidas_batem_com_o_golden_caso_a_caso() {
    for c in parse_cases() {
        let obtido = run_case(&c.input).js_stringify();
        assert_eq!(obtido, c.expected, "caso {} divergiu: {}", c.id, obtido);
    }
}

/// Local (não é corpus): chave extra some e a ordem fixa do TS (stream-trace.ts:135-142).
#[test]
fn clone_reconstroi_forma_fixa_do_ts() {
    let mut source = create_stream_trace(0.0);
    source.set_key("leak", TraceValue::text("x"));
    let out = clone_stream_trace(Some(&source)).expect("clone de objeto");
    assert!(out.get("leak").is_none(), "clone vazou chave extra");
    assert_eq!(
        out.js_stringify(),
        "{\"stages\":{},\"items\":[],\"accountItems\":0,\"startedAt\":0,\"finishedAt\":null,\"chupim\":null}"
    );
}

/// As duas bordas UTF-16 (59 e 159) deixam surrogate órfão. O `expected` traz o
/// escape `\ud83d`; o decoder tolerante reproduz as unidades e o órfão sobrevive
/// no resultado do corte (san-009 no topo, chu-005 aninhado no `chupim`).
#[test]
fn orfaos_borda_59_159_preservados() {
    let cases = parse_cases();

    let san = case(&cases, "stc-san-009");
    let got = run_case(&san.input);
    let text = match &got {
        TraceValue::Text(t) => t,
        other => panic!("esperava texto, veio {other:?}"),
    };
    let inner = san
        .expected
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .expect("literal JSON");
    let decoded = JsText::from_json_string_literal(inner).expect("literal JSON válido");
    assert!(text == &decoded, "san-009: unidades divergem");
    let orfaos = !decoded.is_well_formed();
    assert!(orfaos, "san-009: órfão sumiu");

    let chu = case(&cases, "stc-chu-005");
    let state = run_case(&chu.input);
    let orfao_chu = !chupim_of(&state).is_well_formed();
    assert!(orfao_chu, "chu-005: órfão no chupim");
    let wire = state.js_stringify();
    let wire_ok = wire.contains("\\ud83d");
    assert!(wire_ok, "chu-005: órfão no wire");
}
