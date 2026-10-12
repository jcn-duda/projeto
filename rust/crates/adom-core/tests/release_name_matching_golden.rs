//! Integridade e paridade do golden de `src/utils/release-name-matching.ts`.
//!
//! Cada entrada é um JSON com `op`. `tokens` (em `matches`) é `null` ou lista,
//! como no TS: lista vazia é verdade e não cai no título. `roots` devolve JSON
//! (lista de strings), o mesmo `JSON.stringify` do oracle.

mod common;

use std::collections::HashSet;

use adom_core::{
    contains_token_run, ends_with_sequence_marker, franchise_root, franchise_roots,
    is_multi_work_collection, matches_name, name_coverage_tokens, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/release-name-matching.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/release-name-matching.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-release-name-matching.json");

const REGISTRY_MATCH: &str = "release-name-matching/helpers";

fn bit(v: bool) -> String {
    u8::from(v).to_string()
}

/// `c[key]` como texto, `""` quando ausente ou não é string.
fn text<'a>(c: &'a Value, key: &str) -> &'a str {
    c[key].as_str().unwrap_or("")
}

/// `tokens` do TS: `null` ou ausente é `None`; lista (até vazia) é `Some`.
fn tokens_of(c: &Value) -> Option<Vec<String>> {
    c["tokens"].as_array().map(|list| {
        list.iter()
            .map(|t| t.as_str().unwrap_or("").to_string())
            .collect()
    })
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "matches" => {
            let tokens = tokens_of(&c);
            bit(matches_name(
                text(&c, "title"),
                text(&c, "name"),
                tokens.as_deref(),
            ))
        }
        "coverage" => name_coverage_tokens(text(&c, "name")).join(" "),
        "multiWork" => bit(is_multi_work_collection(text(&c, "title"))),
        "root" => franchise_root(text(&c, "title")),
        "roots" => {
            let names: Vec<String> = c["names"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .map(|n| n.as_str().unwrap_or("").to_string())
                        .collect()
                })
                .unwrap_or_default();
            serde_json::to_string(&franchise_roots(&names)).expect("lista serializa")
        }
        "endsSeq" => bit(ends_with_sequence_marker(text(&c, "title"))),
        "run" => bit(contains_token_run(text(&c, "title"), text(&c, "root"))),
        other => panic!("op desconhecida no golden: {other}"),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/release-name-matching.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-release-name-matching.json"
    );
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
fn golden_tem_uns_e_zeros_nos_booleanos() {
    let outputs: Vec<String> = parse_cases(JSONL_BYTES)
        .into_iter()
        .map(|case| case.expected)
        .collect();
    assert!(outputs.iter().any(|o| o == "1"), "sem caso positivo");
    assert!(outputs.iter().any(|o| o == "0"), "sem caso negativo");
}

#[test]
fn saidas_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
