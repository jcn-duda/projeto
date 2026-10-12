//! Integridade e paridade do golden de `magnet-uri` (sanitize, default e info).
//!
//! Cada entrada é um JSON com `op`. A saída é a URI, o hash ou `null`. As
//! regras de decode e encode, o trim e o `/i` restrito a ASCII são as partes
//! que o golden exercita de propósito (BOM, escape malformado, ſ e K de
//! Kelvin, truncamento de `dn` em code points).

mod common;

use std::collections::HashSet;

use adom_core::{default_magnet, extract_info_hash, sanitize_magnet, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/magnet-uri.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/magnet-uri.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-magnet-uri.json");

const REGISTRY_MATCH: &str = "magnet-uri/sanitize";

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "info" => {
            extract_info_hash(c["text"].as_str().expect("texto")).unwrap_or_else(|| "null".into())
        }
        "default" => default_magnet(c["hash"].as_str().expect("hash")),
        "sanitize" => sanitize_magnet(c["uri"].as_str(), c["hash"].as_str().expect("hash"))
            .unwrap_or_else(|| "null".into()),
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
    assert_eq!(m.output.path, "rust/golden/magnet-uri.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-magnet-uri.json");
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
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
