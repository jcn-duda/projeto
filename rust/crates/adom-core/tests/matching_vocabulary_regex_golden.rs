//! Integridade e paridade do golden de comportamento de `YEAR_RANGE` e
//! `EPISODE_TOKEN`.
//!
//! Cada linha é uma entrada do corpus com o bit de `RegExp.test` do TS para as
//! duas regex (`yr=0|1 ep=0|1`). A comparação é exata: o porte Rust tem de dar
//! o mesmo bit para cada entrada, inclusive nas fronteiras (BOM, NBSP, `ATÉ`,
//! `S01E01` em maiúscula, que não casa porque `EPISODE_TOKEN` não tem `i`).

use std::collections::HashSet;

use adom_core::{episode_token_test, year_range_test, MANIFEST_FORMAT};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/matching-vocabulary-regex.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/matching-vocabulary-regex.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-matching-vocabulary-regex.json");

const REGISTRY_MATCH: &str = "matching-vocabulary/regex";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    registry: Vec<String>,
    corpus: CorpusRef,
    output: OutputRef,
}

#[derive(Debug, Deserialize)]
struct CorpusRef {
    path: String,
    sha256: String,
    cases: usize,
}

#[derive(Debug, Deserialize)]
struct OutputRef {
    path: String,
    sha256: String,
    lines: usize,
}

#[derive(Debug, Deserialize)]
struct GoldenCase {
    id: String,
    input: String,
    expected: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.as_slice() {
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST_TEXT).expect("manifest golden precisa ser JSON válido")
}

fn jsonl_lines() -> Vec<&'static str> {
    let text = std::str::from_utf8(JSONL_BYTES).expect("golden precisa ser UTF-8");
    text.trim_end_matches('\n').split('\n').collect()
}

fn parse_all_cases() -> Vec<GoldenCase> {
    jsonl_lines()
        .iter()
        .map(|line| {
            serde_json::from_str(line).expect("linha do golden commitado precisa ser válida")
        })
        .collect()
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest();
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(jsonl_lines().len(), m.output.lines);
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/matching-vocabulary-regex.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-matching-vocabulary-regex.json"
    );
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest();
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn ids_unicos_e_corpus_concorda_com_o_golden() {
    let cases = parse_all_cases();
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    let corpus: serde_json::Value = serde_json::from_str(CORPUS_TEXT).expect("corpus JSON válido");
    let raw = corpus["cases"].as_array().expect("cases: array");
    assert_eq!(raw.len(), cases.len());
    for (case, row) in cases.iter().zip(raw) {
        assert_eq!(row["id"].as_str(), Some(case.id.as_str()));
        assert_eq!(row["input"].as_str(), Some(case.input.as_str()));
    }
}

#[test]
fn comportamento_das_regex_bate_com_o_golden() {
    for case in parse_all_cases() {
        let yr = u8::from(year_range_test(&case.input));
        let ep = u8::from(episode_token_test(&case.input));
        let obtido = format!("yr={yr} ep={ep}");
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu do golden\nentrada: {:?}",
            case.id, case.input
        );
    }
}
