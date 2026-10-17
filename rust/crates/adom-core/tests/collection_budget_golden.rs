//! Paridade do golden de `collection-budget` (F-1): orçamento da coleta e janela
//! de graça BR.
//!
//! O golden é gerado no worktree `../adom-esm` (o TS original), que aplica no
//! config REAL os números declarados em cada caso antes de chamar a função; aqui
//! os MESMOS números entram por parâmetro. A saída é um inteiro em texto
//! decimal, comparado BYTE A BYTE.

mod common;

use std::collections::HashSet;

use adom_core::{compute_collection_budget, compute_priority_grace, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/collection-budget.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/collection-budget.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-collection-budget.json");

const REGISTRY_MATCH: &str = "collection-budget/computeCollectionBudget";

fn int(v: &Value) -> i64 {
    v.as_i64().expect("número inteiro")
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let cfg = &c["config"];
    match c["op"].as_str().expect("op presente") {
        "budget" => {
            let deadline = if c["deadlineAt"].is_null() {
                None
            } else {
                Some(int(&c["deadlineAt"]))
            };
            compute_collection_budget(
                deadline,
                int(&c["now"]),
                int(&cfg["replyDeadline"]),
                int(&cfg["debridReserve"]),
            )
            .to_string()
        }
        "grace" => compute_priority_grace(
            int(&cfg["brPartialGrace"]),
            int(&cfg["debridReserve"]),
            int(&cfg["debridCheckFloor"]),
        )
        .to_string(),
        other => panic!("op desconhecida: {other}"),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/collection-budget.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-collection-budget.json"
    );
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
    assert!(!cases.is_empty(), "golden não pode ser vazio");
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
