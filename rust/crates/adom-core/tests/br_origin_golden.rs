//! Integridade e paridade do golden de origem BR (`hasPtSigns` e
//! `brOriginMark`). Cada caso é um título; a saída tem dois bits fixos,
//! `pt=` e `origin=`. Inclui o ſ, o K de Kelvin e o ı, onde o `/i` do JS e o
//! Unicode do Rust divergem.

mod common;

use std::collections::HashSet;

use adom_core::{br_origin_mark, has_pt_signs, MANIFEST_FORMAT};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/br-origin.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/br-origin.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-br-origin.json");

const REGISTRY_MATCH: &str = "br-origin/predicates";

fn render(input: &str) -> String {
    let pt = u8::from(has_pt_signs(input));
    let origin = u8::from(br_origin_mark(input));
    format!("pt={pt} origin={origin}")
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/br-origin.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-br-origin.json");
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
fn origem_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {:?}",
            case.id, case.input
        );
    }
}
