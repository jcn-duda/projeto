//! Integridade e paridade do golden de `titleTokens` (fatia de vocabulário).
//!
//! Diferente do teste de `normalizeTitle`, aqui HÁ comparação de paridade: a
//! saída do porte (`title_tokens(input).join(" ")`) é confrontada com o
//! `expected` commitado, que veio do dist do TS. Os tokens nunca são vazios
//! nem contêm espaço, então `join(" ")` é sem perda e a comparação é exata.

use std::collections::HashSet;

use adom_core::{title_tokens, MANIFEST_FORMAT};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/matching-vocabulary-title-tokens.jsonl");
const MANIFEST_TEXT: &str =
    include_str!("../../../golden/matching-vocabulary-title-tokens.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-matching-vocabulary.json");

const REGISTRY_MATCH: &str = "matching-vocabulary/titleTokens";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    registry: Vec<String>,
    function: Function,
    corpus: CorpusRef,
    output: OutputRef,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Function {
    name: String,
    source_path: String,
    source_sha256: String,
    artifact_path: String,
    artifact_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusRef {
    path: String,
    sha256: String,
    cases: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
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
fn manifest_tem_formato_registro_e_oracle_esperados() {
    let m = manifest();
    let f = &m.function;
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(f.name, "titleTokens");
    assert_eq!(f.source_path, "src/utils/matching-vocabulary.ts");
    assert_eq!(f.artifact_path, "dist/src/utils/matching-vocabulary.js");
    assert_eq!(f.source_sha256.len(), 64);
    assert_eq!(f.artifact_sha256.len(), 64);
}

#[test]
fn golden_nao_vazio_e_contagem_bate_com_manifest() {
    let m = manifest();
    let lines = jsonl_lines();
    assert!(!lines.is_empty(), "golden não pode ser vazio");
    assert_eq!(lines.len(), m.output.lines);
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(
        m.output.path,
        "rust/golden/matching-vocabulary-title-tokens.jsonl"
    );
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-matching-vocabulary.json"
    );
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest();
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn casos_tem_ids_unicos() {
    let cases = parse_all_cases();
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    assert_eq!(ids.len(), cases.len());
}

#[test]
fn title_tokens_bate_com_o_golden_caso_a_caso() {
    for case in parse_all_cases() {
        let obtido = title_tokens(&case.input).join(" ");
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu do golden\nentrada:  {:?}\nesperado: {:?}\nobtido:   {:?}",
            case.id, case.input, case.expected, obtido
        );
    }
}

#[test]
fn v_so_some_colado_em_palavra_de_edicao() {
    // "V.Exten" perde o `v`; "V de Vingança" mantém o `v` porque a palavra
    // seguinte não é de edição.
    assert_eq!(
        title_tokens("Apocalypse Now V.Exten"),
        ["apocalypse", "now", "exten"]
    );
    assert_eq!(title_tokens("V de Vingança"), ["v", "de", "vinganca"]);
}
