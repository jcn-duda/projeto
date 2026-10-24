//! Paridade do golden `stream-relabel` (129 casos) para `relabel`.
//!
//! O `expected` do oráculo é **JSON-texto** (`JSON.stringify(resultado)`): o
//! campo já vem com as aspas externas e o surrogate órfão escapado
//! (`\ud800`). A comparação forte é `out.js_stringify() == expected`; além
//! dela, o literal é decodificado com `JsText::from_json_string_literal` (que
//! aceita o órfão como o `JSON.parse`) e as unidades UTF-16 são comparadas.
//!
//! A ENTRADA também carrega órfão: `serde_json` é estrito e recusa `\ud800`
//! sozinho, então `sanitize_input` troca o escape do órfão por um BMP da PUA
//! (registrando o mapa) e `to_jstext` devolve a unidade órfã real. Nunca se
//! perde a unidade nem se cai em U+FFFD.

mod common;

use std::collections::HashSet;

use adom_core::{
    relabel, JsText, RelabelOptions, RelabelStream, StreamDisplayConfig, UserDisplayOptions,
    MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, jsonl_lines, manifest, parse_cases, sha256_hex, GoldenCase};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/stream-relabel.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/stream-relabel.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-stream-relabel.json");
const REGISTRY: &str = "stream-relabel/relabel";
const CASES: usize = 129;

// ── leitura tolerante da entrada ────────────────────────────────────────

/// placeholder BMP -> unidade surrogate órfã.
type PlaceholderMap = Vec<(char, u16)>;

fn is_high(u: u16) -> bool {
    (0xD800..=0xDBFF).contains(&u)
}

fn is_low(u: u16) -> bool {
    (0xDC00..=0xDFFF).contains(&u)
}

fn hex4(cs: &[char]) -> Option<u16> {
    let mut v = 0u32;
    for &c in cs {
        v = v * 16 + c.to_digit(16)?;
    }
    Some(v as u16)
}

/// Troca cada escape `\uXXXX` de surrogate ÓRFÃO por um BMP da PUA livre no
/// texto, para o `serde_json` aceitar; o par surrogate válido é preservado.
fn sanitize_input(json: &str) -> (String, PlaceholderMap) {
    let chars: Vec<char> = json.chars().collect();
    let mut used: Vec<u16> = json.encode_utf16().collect();
    let mut out = String::with_capacity(json.len());
    let mut map: PlaceholderMap = Vec::new();
    let mut next = 0xE000u32;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && chars.get(i + 1) == Some(&'u') && i + 6 <= chars.len() {
            if let Some(v) = hex4(&chars[i + 2..i + 6]) {
                // Par surrogate válido (high + `\uXXXX` low): não é órfão.
                if is_high(v)
                    && i + 12 <= chars.len()
                    && chars[i + 6] == '\\'
                    && chars[i + 7] == 'u'
                {
                    if let Some(low) = hex4(&chars[i + 8..i + 12]) {
                        if is_low(low) {
                            out.extend(chars[i..i + 12].iter().copied());
                            i += 12;
                            continue;
                        }
                    }
                }
                if is_high(v) || is_low(v) {
                    let placeholder = if let Some((p, _)) = map.iter().find(|(_, o)| *o == v) {
                        *p
                    } else {
                        while next <= 0xF8FF && used.contains(&(next as u16)) {
                            next += 1;
                        }
                        let p = char::from_u32(next).expect("PUA é escalar");
                        used.push(next as u16);
                        next += 1;
                        map.push((p, v));
                        p
                    };
                    out.push_str(&format!("\\u{:04x}", placeholder as u32));
                    i += 6;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    (out, map)
}

/// Reconstroi as unidades reais (inclusive o órfão) a partir do placeholder.
fn to_jstext(s: &str, map: &PlaceholderMap) -> JsText {
    let mut units: Vec<u16> = Vec::with_capacity(s.len());
    for c in s.chars() {
        if let Some((_, orphan)) = map.iter().find(|(p, _)| *p == c) {
            units.push(*orphan);
        } else {
            let mut buf = [0u16; 2];
            units.extend(c.encode_utf16(&mut buf).iter().copied());
        }
    }
    JsText::from_units(units)
}

// ── montagem do caso ────────────────────────────────────────────────────

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `runtime.opts()` reduzido às duas chaves do relabel: estilo/fonte ausente,
/// nulo ou falso caem no config; `streamNameShowSource` presente (mesmo nulo)
/// é `Boolean(v)`.
fn user_from_opts(
    opts: &serde_json::Map<String, Value>,
    config: &StreamDisplayConfig,
) -> UserDisplayOptions {
    let style = opts
        .get("streamNameStyle")
        .and_then(|v| if truthy(v) { v.as_str() } else { None })
        .map(str::to_string)
        .unwrap_or_else(|| config.stream_name_style.as_str().to_string());
    let show_source = match opts.get("streamNameShowSource") {
        Some(v) => truthy(v),
        None => config.stream_name_show_source,
    };
    UserDisplayOptions {
        stream_name_style: style,
        stream_name_show_source: show_source,
    }
}

fn render(case: &GoldenCase) -> JsText {
    let (sanitized, map) = sanitize_input(&case.input);
    let root: Value = serde_json::from_str(&sanitized).expect("input precisa ser JSON");
    let config = StreamDisplayConfig::default();

    let stream = root
        .get("stream")
        .and_then(Value::as_object)
        .expect("input precisa de stream");
    let options = root.get("options").and_then(Value::as_object);
    let opts = root.get("opts").and_then(Value::as_object);

    let name = to_jstext(
        stream.get("name").and_then(Value::as_str).unwrap_or(""),
        &map,
    );
    let tracker = stream
        .get("_tracker")
        .and_then(Value::as_str)
        .map(|s| to_jstext(s, &map));
    let magnet = stream
        .get("_magnetDn")
        .and_then(Value::as_str)
        .map(|s| to_jstext(s, &map));
    let dubbed = options
        .and_then(|o| o.get("dubbedFrom"))
        .and_then(Value::as_str)
        .map(|s| to_jstext(s, &map));
    let seeders = stream.get("_seeders").cloned();
    let quality = stream
        .get("_quality")
        .and_then(Value::as_str)
        .map(str::to_string);
    let from_fallback = stream.get("_fromFallback").cloned();
    let from_snapshot = stream.get("_fromSnapshot").cloned();
    let is_br = options
        .and_then(|o| o.get("isBr"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let user = opts.map(|o| user_from_opts(o, &config));

    let relabel_stream = RelabelStream {
        name: &name,
        seeders: seeders.as_ref(),
        quality: quality.as_deref(),
        tracker: tracker.as_ref(),
        magnet_dn: magnet.as_ref(),
        from_fallback: from_fallback.as_ref(),
        from_snapshot: from_snapshot.as_ref(),
    };
    let relabel_options = RelabelOptions {
        is_br,
        dubbed_from: dubbed.as_ref(),
    };
    relabel(&relabel_stream, &relabel_options, user.as_ref(), &config)
}

// ── integridade do golden ───────────────────────────────────────────────

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY.to_string()]);
    assert_eq!(m.output.lines, CASES);
    assert_eq!(m.corpus.cases, CASES);
    assert_eq!(jsonl_lines(JSONL_BYTES).len(), CASES);
    assert_eq!(m.output.path, "rust/golden/stream-relabel.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-stream-relabel.json");
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn ids_unicos_e_corpus_concorda_com_o_golden() {
    let cases = parse_cases(JSONL_BYTES);
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    assert_corpus_matches(CORPUS_TEXT, &cases);
}

// ── paridade ────────────────────────────────────────────────────────────

#[test]
fn casos_batem_com_o_golden() {
    let cases = parse_cases(JSONL_BYTES);
    assert_eq!(cases.len(), CASES);
    for case in &cases {
        let out = render(case);
        assert_eq!(
            out.js_stringify(),
            case.expected,
            "caso {} divergiu (input {})",
            case.id,
            case.input
        );
    }
}

#[test]
fn unidades_utf16_e_expected_json_roundtrip() {
    for case in parse_cases(JSONL_BYTES) {
        let out = render(&case);
        let inner = &case.expected[1..case.expected.len() - 1];
        let decoded =
            JsText::from_json_string_literal(inner).expect("literal do oráculo decodifica");
        assert_eq!(
            decoded.as_units(),
            out.as_units(),
            "caso {}: unidades UTF-16",
            case.id
        );
        assert_eq!(
            decoded.js_stringify(),
            case.expected,
            "caso {}: re-escape",
            case.id
        );
    }
}

/// Os vetores com surrogate órfão precisam passar pelo protocolo `js_stringify`
/// sem virar U+FFFD e sem dropar a unidade. A contagem é medida (4), não
/// presumida.
#[test]
fn vetores_orfaos_preservam_a_unidade() {
    let cases = parse_cases(JSONL_BYTES);
    let mut orphans: Vec<String> = Vec::new();
    for case in &cases {
        let inner = &case.expected[1..case.expected.len() - 1];
        let decoded = JsText::from_json_string_literal(inner).expect("literal decodifica");
        let out = render(case);
        assert_eq!(
            decoded.as_units(),
            out.as_units(),
            "caso {}: unidades UTF-16",
            case.id
        );
        if decoded.is_well_formed() {
            assert!(out.is_well_formed(), "caso {}: saída bem formada", case.id);
        } else {
            assert!(
                !out.is_well_formed(),
                "caso {}: o órfão não pode ser dropado",
                case.id
            );
            let lossy = String::from_utf16_lossy(out.as_units());
            let lossy_json = serde_json::to_string(&lossy).expect("lossy é string");
            assert_ne!(
                lossy_json, case.expected,
                "caso {}: U+FFFD não reproduz o contrato",
                case.id
            );
            orphans.push(case.id.clone());
        }
    }
    let esperados: Vec<String> = ["i-01", "i-02", "i-03", "i-08"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(orphans, esperados, "vetores órfãos do golden");
}
