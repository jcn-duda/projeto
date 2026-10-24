//! Integridade e paridade do golden de `sourceFromTitle`, `editionFromTitle` e
//! `compactAudio`.
//!
//! A entrada é um JSON `{op,text}` e a saída é a string crua devolvida pela
//! função correspondente (`""` quando não há rótulo). Sem normalizar a saída.

mod common;

use std::collections::HashSet;

use adom_core::{compact_audio, edition_from_title, source_from_title, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/release-labels.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/release-labels.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-release-labels.json");

const REGISTRY_MATCH: &str = "release-labels/releaseLabels";

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let text = c["text"].as_str().expect("campo text");
    let out = match c["op"].as_str().expect("campo op") {
        "source" => source_from_title(text),
        "edition" => edition_from_title(text),
        "compact" => compact_audio(text),
        other => panic!("op desconhecida no golden: {other}"),
    };
    out.to_string()
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/release-labels.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-release-labels.json");
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
fn rotulos_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
