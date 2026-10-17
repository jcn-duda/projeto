//! Paridade do golden de `search-pool-coverage` (F-1): cobertura por pool e
//! cobertura do índice.
//!
//! O golden é gerado no worktree `../adom-esm` (o TS original). O `minSeeders`
//! declarado em cada caso é o que o oráculo aplica na config VIVA do autofetch
//! (o TS o lê dentro de `poolCovered`); aqui ele entra por parâmetro — o núcleo
//! não conhece config.
//!
//! # Comparação
//!
//! `poolCovered` devolve booleano: comparado byte a byte (`"true"`/`"false"`).
//! `idxPoolCovered` devolve `{covered, packOnly}`: comparado por
//! `serde_json::Value` (ordem de chave insensível; o `packOnly` foi MEDIDO no
//! oráculo pela métrica `search.idx.packOnly`, não inferido).

mod common;

use std::collections::HashSet;

use adom_core::{idx_pool_covered, pool_covered, PoolCoverageItem, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex, GoldenCase};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/search-pool-coverage.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/search-pool-coverage.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-search-pool-coverage.json");

const REGISTRY_MATCH: &str = "search-pool-coverage/poolCovered";

fn opt_i64(v: &Value) -> Option<i64> {
    v.as_i64()
}

fn items(v: &Value) -> Vec<PoolCoverageItem> {
    serde_json::from_value(v.clone()).expect("itens do corpus são válidos")
}

/// `Option<f64>` do piso: ausente no corpus = o default do TS (3).
fn min_seeders(c: &Value) -> f64 {
    c["minSeeders"].as_f64().unwrap_or(3.0)
}

fn render(input: &str) -> Value {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("op presente") {
        "pool" => Value::Bool(pool_covered(
            &items(&c["items"]),
            opt_i64(&c["season"]),
            c["requireDubbed"].as_bool().unwrap_or(false),
            min_seeders(&c),
        )),
        "idx" => serde_json::to_value(idx_pool_covered(
            &items(&c["releases"]),
            opt_i64(&c["season"]),
            opt_i64(&c["episode"]),
            min_seeders(&c),
        ))
        .expect("cobertura serializa"),
        other => panic!("op desconhecida: {other}"),
    }
}

/// Escalar bate byte a byte; objeto (`idx`) bate por `Value`.
fn assert_case(case: &GoldenCase) {
    let obtido = render(&case.input);
    let esperado: Value = serde_json::from_str(&case.expected).expect("expected é JSON");
    match &esperado {
        Value::Bool(b) => assert_eq!(
            obtido,
            Value::Bool(*b),
            "caso {} divergiu: {}",
            case.id,
            case.input
        ),
        _ => assert_eq!(
            obtido, esperado,
            "caso {} divergiu: {}",
            case.id, case.input
        ),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/search-pool-coverage.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-search-pool-coverage.json"
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
fn cobertura_bate_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        assert_case(&case);
    }
}
