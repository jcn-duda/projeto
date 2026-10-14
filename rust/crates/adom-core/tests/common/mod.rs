//! Helpers compartilhados pelos testes de golden: manifest, hashes sha256 e
//! parse do JSONL. Cada teste de golden importa este módulo com `mod common;`.
#![allow(dead_code)]

use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub registry: Vec<String>,
    pub corpus: CorpusRef,
    pub output: OutputRef,
}

#[derive(Debug, Deserialize)]
pub struct CorpusRef {
    pub path: String,
    pub sha256: String,
    pub cases: usize,
}

#[derive(Debug, Deserialize)]
pub struct OutputRef {
    pub path: String,
    pub sha256: String,
    pub lines: usize,
}

#[derive(Debug, Deserialize)]
pub struct GoldenCase {
    pub id: String,
    pub input: String,
    pub expected: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.as_slice() {
        let _ = write!(out, "{b:02x}");
    }
    out
}

pub fn manifest(text: &str) -> Manifest {
    serde_json::from_str(text).expect("manifest golden precisa ser JSON válido")
}

/// Linhas não vazias do JSONL, sem o `\n` final.
pub fn jsonl_lines(bytes: &'static [u8]) -> Vec<&'static str> {
    let text = std::str::from_utf8(bytes).expect("golden precisa ser UTF-8");
    text.trim_end_matches('\n').split('\n').collect()
}

pub fn parse_cases(bytes: &'static [u8]) -> Vec<GoldenCase> {
    jsonl_lines(bytes)
        .iter()
        .map(|line| {
            serde_json::from_str(line).expect("linha do golden commitado precisa ser válida")
        })
        .collect()
}

/// Confere que o corpus JSON tem os mesmos ids e entradas que o golden, na
/// mesma ordem. Só `input`: nunca compara `expected` aqui.
pub fn assert_corpus_matches(corpus_text: &str, cases: &[GoldenCase]) {
    let corpus: serde_json::Value = serde_json::from_str(corpus_text).expect("corpus JSON válido");
    let raw = corpus["cases"].as_array().expect("cases: array");
    assert_eq!(
        raw.len(),
        cases.len(),
        "contagem do corpus diverge do golden"
    );
    for (case, row) in cases.iter().zip(raw) {
        assert_eq!(row["id"].as_str(), Some(case.id.as_str()));
        assert_eq!(row["input"].as_str(), Some(case.input.as_str()));
    }
}
