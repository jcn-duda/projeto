//! Integridade e paridade do golden de `shortNameTailContradicts`.
//!
//! A entrada é um JSON com tokens, `check` (skip, no-token ou prefix) e
//! universe. Só `prefix` com um token no `run` chega à função; o resto é "não
//! corta", como no TS.

mod common;

use std::collections::HashSet;

use adom_core::{short_name_tail_contradicts, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/short-name-tail.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/short-name-tail.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-short-name-tail.json");

const REGISTRY_MATCH: &str = "short-name-tail/shortNameTailContradicts";

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("lista de strings")
        .iter()
        .map(|x| x.as_str().expect("string").to_string())
        .collect()
}

/// Mesmo critério do TS: só `kind === 'prefix'` com `run.length === 1` chega ao
/// corte; qualquer outro caso vira `None`.
fn name_token(check: &Value) -> Option<String> {
    if check["kind"].as_str() != Some("prefix") {
        return None;
    }
    let run = strings(&check["run"]);
    (run.len() == 1).then(|| run[0].clone())
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let universe: HashSet<String> = strings(&c["universe"]).into_iter().collect();
    let token = name_token(&c["check"]);
    let hit = short_name_tail_contradicts(&strings(&c["tokens"]), token.as_deref(), &universe);
    if hit { "1" } else { "0" }.to_string()
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/short-name-tail.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-short-name-tail.json");
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
fn decisoes_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
