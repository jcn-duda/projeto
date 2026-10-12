//! Integridade e paridade do golden de `remainingCheckBudget`.
//!
//! A saída é o orçamento em texto decimal, ou o literal `null` quando não há
//! prazo. `0` é prazo vencido.

mod common;

use std::collections::HashSet;

use adom_core::{remaining_check_budget, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/reply-budget.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/reply-budget.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-reply-budget.json");

const REGISTRY_MATCH: &str = "reply-budget/remainingCheckBudget";

fn json_i64(v: &Value) -> i64 {
    v.as_i64().expect("número inteiro")
}

/// `null` no JSON é ausência de prazo (`None`).
fn json_i64_opt(v: &Value) -> Option<i64> {
    if v.is_null() {
        None
    } else {
        Some(json_i64(v))
    }
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let out = remaining_check_budget(
        json_i64_opt(&c["deadlineAt"]),
        json_i64(&c["now"]),
        json_i64(&c["margin"]),
    );
    out.map(|n| n.to_string())
        .unwrap_or_else(|| "null".to_string())
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/reply-budget.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-reply-budget.json");
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
fn orcamentos_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
