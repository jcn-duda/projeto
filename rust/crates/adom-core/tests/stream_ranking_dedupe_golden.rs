//! Golden de `dedupeByHash` (`src/utils/stream-ranking.ts`) →
//! `adom-core::stream_ranking_dedupe`.
//!
//! O `expected` veio do dist vivo pelo oráculo
//! `scripts/golden/dedupe-by-hash-oracle.mjs`: JSON canônico (chaves
//! ordenadas recursivamente, números no formato do `JSON.stringify`) de
//! `{ streams, drops }`, com `drops` = `trace.items` sem o `id` posicional.

mod common;

use std::collections::HashSet;

use adom_core::{dedupe_by_hash, DedupeInput, RankingStream, MANIFEST_FORMAT};
use serde_json::{Map, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/stream-ranking-dedupe.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/stream-ranking-dedupe.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-dedupe-by-hash.json");

const REGISTRY_MATCH: &str = "stream-ranking/dedupeByHash";
const CASES: usize = 40;

/// Número no formato do `JSON.stringify` do JS (inteiro sem casas).
fn js_num(n: f64) -> String {
    if n == 0.0 {
        return "0".to_string(); // cobre -0
    }
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        serde_json::to_string(&n).expect("f64 finito serializa")
    }
}

/// JSON canônico: chaves ordenadas, sem espaços — o mesmo contrato do oráculo.
fn js_canon(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&js_num(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("string serializa")),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_canon(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("chave serializa"));
                out.push(':');
                js_canon(&map[*key], out);
            }
            out.push('}');
        }
    }
}

fn parse_streams(v: &Value) -> Vec<RankingStream> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|s| {
                    serde_json::from_value(s.clone())
                        .expect("stream do corpus desserializa no RankingStream")
                })
                .collect()
        })
        .unwrap_or_default()
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let input = DedupeInput {
        streams: parse_streams(&c["streams"]),
        indexer_priority: c["indexerPriority"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
    };
    let out = dedupe_by_hash(&input);
    let mut root = Map::new();
    root.insert(
        "streams".to_string(),
        serde_json::to_value(&out.streams).expect("streams serializam"),
    );
    root.insert(
        "drops".to_string(),
        serde_json::to_value(&out.drops).expect("drops serializam"),
    );
    let mut text = String::new();
    js_canon(&Value::Object(root), &mut text);
    text
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/stream-ranking-dedupe.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-dedupe-by-hash.json");
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

#[test]
fn saidas_batem_com_o_golden_caso_a_caso() {
    let cases = parse_cases(JSONL_BYTES);
    assert_eq!(cases.len(), CASES, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
