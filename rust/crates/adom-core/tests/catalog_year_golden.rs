//! Integridade e paridade do golden de `catalogYearOf` e `catalogAltYearOf`.
//!
//! A saída é o ano em texto (ou `null`). Para `catalogAltYearOf` o número
//! sai como texto decimal, como o `String(n)` do JS.

mod common;

use std::collections::HashSet;

use adom_core::{catalog_alt_year_of, catalog_year_of, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/catalog-year.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/catalog-year.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-catalog-year.json");

const REGISTRY_MATCH: &str = "catalog-year/catalogYear";

/// Ano como texto ou `None` para `null`, como o argumento chega no JS.
fn text_arg(v: &Value) -> Option<&str> {
    v.as_str()
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let (meta, tmdb) = (text_arg(&c["meta"]), text_arg(&c["tmdb"]));
    let out = match c["op"].as_str().expect("campo op") {
        "catalog" => catalog_year_of(meta, tmdb).map(str::to_string),
        "alt" => catalog_alt_year_of(meta, tmdb).map(|n| n.to_string()),
        other => panic!("op desconhecida no golden: {other}"),
    };
    out.unwrap_or_else(|| "null".to_string())
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/catalog-year.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-catalog-year.json");
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
fn anos_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
