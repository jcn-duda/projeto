//! Paridade do golden `stream-display` (124 casos) para `streamDisplayName` e
//! `compactTracker`.
//!
//! O contrato de comparação é o `expectedJson` do oráculo Node
//! (`JSON.stringify(resultado)`, SEMPRE JSON válido). O campo `expected` é texto
//! cru e é OMITIDO nos 4 vetores com surrogate órfão (o `serde_json` estrito
//! recusaria) — por isso o leitor aceita `expected: Option<String>` e NÃO pode
//! depender dele para os órfãos. A igualdade das unidades UTF-16 é feita por
//! `JsText::from_json_string_literal`, que decodifica o órfão como o `JSON.parse`
//! do Node.

mod common;

use std::collections::HashSet;

use adom_core::{
    compact_tracker, stream_display_name, JsText, StreamDisplayConfig, StreamDisplayOptions,
    StreamNameStyle, UserDisplayOptions, MANIFEST_FORMAT,
};
use serde::Deserialize;
use serde_json::Value;

use common::{jsonl_lines, manifest, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/stream-display.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/stream-display.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-stream-display.json");
const REGISTRY: &str = "stream-display/streamDisplayName";
const ORPHAN_VECTORS: [&str; 4] = ["sd-083", "sd-084", "sd-085", "sd-086"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    config: CaseConfig,
    input: String,
    /// Texto cru; ausente quando `orphanSurrogate`.
    expected: Option<String>,
    expected_json: String,
    orphan_surrogate: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaseConfig {
    style: String,
    show_source: String,
}

fn parse_cases() -> Vec<Case> {
    jsonl_lines(JSONL_BYTES)
        .iter()
        .map(|line| serde_json::from_str(line).expect("linha do golden precisa ser válida"))
        .collect()
}

fn config_of(c: &CaseConfig) -> StreamDisplayConfig {
    StreamDisplayConfig {
        stream_name_style: if c.style == "full" {
            StreamNameStyle::Full
        } else {
            StreamNameStyle::Compact
        },
        stream_name_show_source: c.show_source != "false",
    }
}

/// `Boolean(v)` do JS para os valores que o corpus usa em `showSource`.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `runtime.normalize(userOpts)` reduzido às duas chaves do SCHEMA (`ns`/`st`):
/// ausente/`null` cai no config; `ns` presente vira `String` (inclusive `""`).
fn normalize_user(u: &Value, config: &StreamDisplayConfig) -> UserDisplayOptions {
    let style = match u.get("ns") {
        None | Some(Value::Null) => config.stream_name_style.as_str().to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    let show_source = match u.get("st") {
        None | Some(Value::Null) => config.stream_name_show_source,
        Some(v) => truthy(v),
    };
    UserDisplayOptions {
        stream_name_style: style,
        stream_name_show_source: show_source,
    }
}

fn render(case: &Case, input: &Value) -> JsText {
    let config = config_of(&case.config);
    let opts = input.get("opts").expect("input precisa de opts");
    let user = input.get("userOpts").map(|u| normalize_user(u, &config));
    let options = StreamDisplayOptions {
        title: opts.get("title").and_then(Value::as_str),
        quality: opts.get("quality").and_then(Value::as_str),
        audio: opts.get("audio").and_then(Value::as_str),
        source: opts.get("source").and_then(Value::as_str),
        edition: opts.get("edition").and_then(Value::as_str),
        tracker: opts.get("tracker").and_then(Value::as_str),
        is_br: opts.get("isBr").and_then(Value::as_bool).unwrap_or(false),
        seeders: opts.get("seeders"),
        from_fallback: opts
            .get("fromFallback")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        style: opts.get("style").and_then(Value::as_str),
        // Presente-mas-null conta como falso (`showSource !== undefined`).
        show_source: opts.get("showSource").map(truthy),
    };
    stream_display_name(&options, user.as_ref(), &config)
}

fn render_case(case: &Case) -> JsText {
    let input: Value = serde_json::from_str(&case.input).expect("input é JSON");
    render(case, &input)
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY.to_string()]);
    assert_eq!(m.output.lines, 124);
    assert_eq!(m.corpus.cases, 124);
    assert_eq!(jsonl_lines(JSONL_BYTES).len(), 124);
    assert_eq!(m.output.path, "rust/golden/stream-display.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-stream-display.json");
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn ids_unicos_e_corpus_concorda_com_o_golden() {
    let cases = parse_cases();
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    let golden: Vec<common::GoldenCase> = cases
        .iter()
        .map(|c| common::GoldenCase {
            id: c.id.clone(),
            input: c.input.clone(),
            expected: c.expected.clone().unwrap_or_default(),
        })
        .collect();
    common::assert_corpus_matches(CORPUS_TEXT, &golden);
}

#[test]
fn casos_batem_por_expected_json() {
    for case in parse_cases() {
        let out = render_case(&case);
        assert_eq!(
            out.js_stringify(),
            case.expected_json,
            "caso {} divergiu (input {})",
            case.id,
            case.input
        );
        assert_eq!(
            case.orphan_surrogate,
            case.expected.is_none(),
            "contrato de órfão diverge no caso {}",
            case.id
        );
    }
}

#[test]
fn unidades_utf16_batem_e_literal_json_roundtrip() {
    for case in parse_cases() {
        let out = render_case(&case);
        // Sem órfão, o `expected` CRU tem que bater byte a byte (Text→Rust é estrito).
        if let Some(expected) = &case.expected {
            let strict =
                String::from_utf16(out.as_units()).expect("caso sem órfão é UTF-16 válido");
            assert_eq!(&strict, expected, "caso {}: texto cru", case.id);
        }
        // Com ou sem órfão, o literal do oráculo reconstroi as MESMAS unidades.
        let inner = &case.expected_json[1..case.expected_json.len() - 1];
        let decoded = JsText::from_json_string_literal(inner)
            .expect("literal do oráculo decodifica, inclusive órfão");
        assert_eq!(
            decoded.as_units(),
            out.as_units(),
            "caso {}: unidades UTF-16",
            case.id
        );
        assert_eq!(
            decoded.js_stringify(),
            case.expected_json,
            "caso {}: re-escape",
            case.id
        );
    }
}

/// Guarda de contagem: os 4 vetores do `manifest.traps` precisam passar pelo
/// protocolo `js_stringify`. Se o porte fosse via `String` lossy, o órfão viraria
/// U+FFFD e a comparação com `expectedJson` falharia — provado pelo assert
/// negativo.
#[test]
fn vetores_orfaos_passam_pelo_protocolo_js_stringify() {
    let m: Value = serde_json::from_str(MANIFEST_TEXT).expect("manifest é JSON");
    let trap = &m["traps"][0];
    let ids: Vec<String> = trap["vectorIds"]
        .as_array()
        .expect("vectorIds")
        .iter()
        .map(|v| v.as_str().expect("id string").to_string())
        .collect();
    assert_eq!(trap["count"].as_u64(), Some(4));
    assert_eq!(ids, ORPHAN_VECTORS.to_vec());

    let cases = parse_cases();
    for id in &ids {
        let case = cases
            .iter()
            .find(|c| &c.id == id)
            .unwrap_or_else(|| panic!("caso órfão ausente: {id}"));
        assert!(case.orphan_surrogate, "{id}: flag orphanSurrogate");
        assert!(
            case.expected.is_none(),
            "{id}: `expected` cru precisa faltar"
        );
        let out = render_case(case);
        assert!(!out.is_well_formed(), "{id}: órfão não pode ser dropado");
        assert_eq!(out.js_stringify(), case.expected_json, "{id}: js_stringify");
        let lossy = String::from_utf16_lossy(out.as_units());
        let lossy_json = serde_json::to_string(&lossy).expect("lossy é string");
        assert_ne!(
            lossy_json, case.expected_json,
            "{id}: String lossy não pode reproduzir o contrato"
        );
    }

    for case in &cases {
        if !ids.contains(&case.id) {
            assert!(
                !case.orphan_surrogate,
                "{}: órfão fora do manifest",
                case.id
            );
        }
    }
}

#[test]
fn compact_tracker_preserva_o_orfao_e_as_fronteiras() {
    assert_eq!(
        compact_tracker("AAAAABBBBBCCC\u{1F600}DD").js_stringify(),
        "\"AAAAABBBBBCCC\\ud83d\""
    );
    assert_eq!(
        compact_tracker("AAAAABBBBBCCC\u{2A6E0}DD").js_stringify(),
        "\"AAAAABBBBBCCC\\ud869\""
    );
    assert_eq!(
        compact_tracker("TorrentDosFilmes").js_stringify(),
        "\"TorrentDos\""
    );
    assert_eq!(
        compact_tracker("Site-Muito-Longo-Aqui").js_stringify(),
        "\"Site-Muito\""
    );
    assert_eq!(
        compact_tracker("kickasstorrents.com.br").js_stringify(),
        "\"kickass\""
    );
    assert!(compact_tracker("Curt\u{1F600}").is_well_formed());
}
