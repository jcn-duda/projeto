//! Integridade e paridade do golden de `collapseAcronyms`.
//!
//! A saída é a string crua do Node. O espaço depois da sigla só entra quando
//! a unidade UTF-16 seguinte é letra ou número (`charAt`).

mod common;

use std::collections::HashSet;

use adom_core::{collapse_acronyms, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/collapse-acronyms.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/collapse-acronyms.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-collapse-acronyms.json");

const REGISTRY_MATCH: &str = "collapse-acronyms/collapseAcronyms";

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let text = c["text"].as_str().expect("campo text");
    collapse_acronyms(text)
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/collapse-acronyms.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-collapse-acronyms.json"
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
fn siglas_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
