//! Golden de `src/providers/autofetch-keys.ts` → `adom-core::autofetch_keys`.
//!
//! Cobre `dead_key`: a chave `autofetch:v3:dead:<adapter>:<conta>:<hash>` com o
//! hash normalizado em minúsculas. O `expected` veio do dist vivo pelo oráculo
//! `scripts/golden/autofetch-keys-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{dead_key, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-keys.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-keys.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-autofetch-keys.json");

const REGISTRY_MATCH: &str = "autofetch-keys/deadKey";

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "deadKey" => dead_key(
            c["adapterId"].as_str().unwrap_or(""),
            c["account"].as_str().unwrap_or(""),
            c["infoHash"].as_str().unwrap_or(""),
        ),
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
    assert_eq!(m.output.path, "rust/golden/autofetch-keys.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-autofetch-keys.json");
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
    assert_eq!(cases.len(), 10, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
