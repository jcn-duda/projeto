//! Integridade e paridade do golden de `magnetDisplayName`.
//!
//! A saída é o `dn=` com `+` virado espaço e `decodeURIComponent` aplicado
//! por inteiro. String vazia quando não há magnet ou não há `dn=`.

mod common;

use std::collections::HashSet;

use adom_core::{magnet_display_name, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/magnet-display-name.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/magnet-display-name.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-magnet-display-name.json");

const REGISTRY_MATCH: &str = "magnet-display-name/magnetDisplayName";

/// Texto ou `None` para `null`, como o argumento chega no JS.
fn text_arg(v: &Value) -> Option<&str> {
    v.as_str()
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    magnet_display_name(
        text_arg(&c["magnet"]),
        text_arg(&c["magnetUri"]),
        text_arg(&c["guid"]),
    )
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/magnet-display-name.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-magnet-display-name.json"
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
fn nomes_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
