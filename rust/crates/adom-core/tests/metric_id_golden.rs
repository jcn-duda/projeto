//! Integridade e paridade do golden de `safeMetricId`/`indexerFallbackMetricKey`
//! (`src/utils/metric-id.ts`).
//!
//! A entrada é JSON (`{"op":"safe"|"key","value":<qualquer>}`); `value`
//! ausente é `undefined` para o TS. A saída é o id normalizado (ASCII) ou, em
//! `key`, o id prefixado por `fallback.indexer.`.

mod common;

use std::collections::HashSet;

use adom_core::{indexer_fallback_metric_key, safe_metric_id, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/metric-id.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/metric-id.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-metric-id.json");

const REGISTRY_MATCH: &str = "metric-id/metricId";

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        // `value` ausente indexa para `Value::Null` (undefined/falsy no TS).
        "safe" => safe_metric_id(&c["value"]),
        "key" => indexer_fallback_metric_key(&c["value"]),
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
    assert_eq!(m.output.path, "rust/golden/metric-id.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-metric-id.json");
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
fn ids_batem_com_o_golden_caso_a_caso() {
    let cases = parse_cases(JSONL_BYTES);
    // Catraca de contagem: uma regeneração que encolha o corpus junto com o
    // manifest não passa aqui.
    assert_eq!(cases.len(), 71, "contagem de casos do corpus mudou");
    for case in cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
