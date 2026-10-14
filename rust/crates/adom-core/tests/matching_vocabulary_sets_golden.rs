//! Integridade e paridade do golden de conteúdo das constantes de vocabulário.
//!
//! Cada linha do golden é uma constante exportada pelo TS
//! (`PACK_WORDS`, `TECH_NOISE`, `NUMERAL_CANON`, regex…) com o conteúdo ordenado
//! e sem repetição. A comparação é exata: `vocabulary_contents(nome)` contra o
//! `expected` commitado, então qualquer erro de transcrição aparece aqui.

use std::collections::HashSet;

use adom_core::{vocabulary_contents, MANIFEST_FORMAT};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/matching-vocabulary-sets.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/matching-vocabulary-sets.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-matching-vocabulary-sets.json");

const REGISTRY_MATCH: &str = "matching-vocabulary/sets";

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
    assert_eq!(m.output.path, "rust/golden/matching-vocabulary-sets.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-matching-vocabulary-sets.json"
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
fn conteudo_das_constantes_bate_com_o_golden() {
    for case in parse_all_cases() {
        let obtido = vocabulary_contents(&case.input)
            .unwrap_or_else(|| panic!("constante desconhecida no porte: {}", case.input));
        assert_eq!(
            obtido, case.expected,
            "caso {} ({}) divergiu do golden",
            case.id, case.input
        );
    }
}

#[test]
fn nome_desconhecido_nao_tem_conteudo() {
    assert_eq!(vocabulary_contents("NAO_EXISTE"), None);
}
