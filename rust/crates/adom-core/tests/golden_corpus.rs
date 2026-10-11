//! Consumo e integridade do golden de `normalizeTitle` (fatia F0).
//!
//! Este teste NÃO porta nem reimplementa `normalizeTitle` e NÃO trata `input`
//! como equivalente a `expected` — não há comparação de paridade aqui. O alvo é
//! só o contrato on-disk: bytes, hashes sha256, contagem e formato batem com o
//! manifest; as strings entram e saem exatamente como foram commitadas (UTF-8,
//! inclusive formas NFD). Tudo por `include_bytes!`/`include_str!` em tempo de
//! compilação: sem I/O de runtime e sem rede.

use std::collections::HashSet;

use adom_core::MANIFEST_FORMAT;
use serde::Deserialize;
use sha2::{Digest, Sha256};

// Caminhos estáveis, ancorados no repo (crate em `rust/crates/adom-core`).
const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/title-normalization.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/title-normalization.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-title-normalization.json");

const REGISTRY_MATCH: &str = "title-normalization/normalizeTitle";

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

/// Caso do golden, com as strings cruas — nada é normalizado no parse.
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

/// Parser mínimo com `Result`: linha malformada, campo ausente ou campo não
/// string viram `Err` (nunca `panic!`). Os negativos rodam em memória.
fn parse_case(line: &str) -> Result<GoldenCase, String> {
    serde_json::from_str(line).map_err(|e| format!("linha JSONL inválida: {e}"))
}

fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST_TEXT).expect("manifest golden precisa ser JSON válido")
}

/// Linhas não vazias do JSONL, sem o `\n` final.
fn jsonl_lines() -> Vec<&'static str> {
    let text = std::str::from_utf8(JSONL_BYTES).expect("golden precisa ser UTF-8");
    text.trim_end_matches('\n').split('\n').collect()
}

fn parse_all_cases() -> Vec<GoldenCase> {
    jsonl_lines()
        .iter()
        .map(|line| parse_case(line).expect("linha do golden commitado precisa ser válida"))
        .collect()
}

fn case_by_id<'a>(cases: &'a [GoldenCase], id: &str) -> &'a GoldenCase {
    cases
        .iter()
        .find(|case| case.id == id)
        .unwrap_or_else(|| panic!("caso ausente no golden: {id}"))
}

#[test]
fn manifest_tem_formato_registro_e_oracle_esperados() {
    let m = manifest();
    let f = &m.function;
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(f.name, "normalizeTitle");
    assert_eq!(f.source_path, "src/utils/title-normalization.ts");
    assert_eq!(f.artifact_path, "dist/src/utils/title-normalization.js");
    assert_eq!(f.source_sha256.len(), 64);
    assert_eq!(f.artifact_sha256.len(), 64);
}

#[test]
fn corpus_jsonl_nao_vazio_e_contagem_bate_com_manifest() {
    let m = manifest();
    let (o, c) = (&m.output, &m.corpus);
    let lines = jsonl_lines();
    assert!(!lines.is_empty(), "golden não pode ser vazio");
    assert_eq!(lines.len(), o.lines);
    assert_eq!(o.lines, c.cases);
    assert_eq!(o.path, "rust/golden/title-normalization.jsonl");
    assert_eq!(c.path, "scripts/golden/corpus-title-normalization.json");
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest();
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn casos_tem_ids_unicos_e_campos_string() {
    let cases = parse_all_cases();
    assert!(!cases.is_empty(), "sem casos não há o que validar");
    let mut ids = HashSet::new();
    for case in &cases {
        let id = case.id.as_str();
        assert!(!id.is_empty(), "id vazio");
        assert!(ids.insert(id), "id duplicado: {id}");
    }
    assert_eq!(ids.len(), cases.len());
}

#[test]
fn corpus_fonte_e_jsonl_concordam_em_ids_e_ordem() {
    let cases = parse_all_cases();
    let corpus: serde_json::Value = serde_json::from_str(CORPUS_TEXT).expect("corpus JSON válido");
    let raw = corpus["cases"].as_array().expect("cases: array");
    assert_eq!(raw.len(), cases.len(), "contagem diverge");
    // Só `input` de cada artefato: nunca `input` x `expected` (isso seria paridade).
    for (case, row) in cases.iter().zip(raw) {
        assert_eq!(row["id"].as_str(), Some(case.id.as_str()));
        assert_eq!(row["input"].as_str(), Some(case.input.as_str()));
    }
}

#[test]
fn entrada_nfd_e_nfc_preservadas_sem_normalizar() {
    let cases = parse_all_cases();
    let nfc = case_by_id(&cases, "tn-010"); // "Poção do Avô" pré-composto
    let nfd = case_by_id(&cases, "tn-011"); // mesma palavra em NFD (base + combinantes)
    assert_ne!(nfc.input, nfd.input, "NFC e NFD não podem colapsar");
    assert!(nfc.input.contains('\u{00e7}'));
    assert!(nfc.input.contains('\u{00e3}'));
    assert!(nfc.input.contains('\u{00f4}'));
    assert!(nfd.input.contains('\u{0327}'));
    assert!(nfd.input.contains('\u{0303}'));
    assert!(nfd.input.contains('\u{0302}'));
    // Saída NFD do dakuten japonês preservada como está no golden.
    assert!(case_by_id(&cases, "tn-018").expected.contains('\u{3099}'));
}

#[test]
fn parser_rejeita_entradas_invalidas() {
    // Caminhos inválidos em memória; a produção devolve `Err`, sem `unwrap`.
    assert!(parse_case("").is_err(), "linha vazia");
    assert!(parse_case("não é json").is_err(), "texto solto");
    assert!(parse_case("{}").is_err(), "campos ausentes");
    let missing = r#"{"id":"x","input":"y"}"#;
    let wrong_type = r#"{"id":1,"input":"y","expected":"z"}"#;
    let valid = r#"{"id":"x","input":"y","expected":"z"}"#;
    assert!(parse_case(missing).is_err());
    assert!(parse_case(wrong_type).is_err());
    assert!(parse_case(valid).is_ok());
}
