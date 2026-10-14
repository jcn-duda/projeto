//! Integridade e paridade do golden de `bytesToSize`.
//!
//! A saída é o texto do tamanho (`"1.46 KB"`) ou o literal `null`. NaN e
//! infinito não cabem no JSON do corpus; o teste abaixo cobre esses dois.

mod common;

use std::collections::HashSet;

use adom_core::{bytes_to_size, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/bytes-to-size.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/bytes-to-size.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-bytes-to-size.json");

const REGISTRY_MATCH: &str = "bytes-to-size/bytesToSize";

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let bytes = c["bytes"].as_f64().expect("campo bytes numérico");
    bytes_to_size(bytes).unwrap_or_else(|| "null".to_string())
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/bytes-to-size.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-bytes-to-size.json");
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
fn tamanhos_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}

/// NaN e infinito não serializam em JSON. O contrato é o mesmo do
/// `Number.isFinite`: sem tamanho.
#[test]
fn nao_finitos_nao_tem_tamanho() {
    assert_eq!(bytes_to_size(f64::NAN), None);
    assert_eq!(bytes_to_size(f64::INFINITY), None);
    assert_eq!(bytes_to_size(f64::NEG_INFINITY), None);
}
