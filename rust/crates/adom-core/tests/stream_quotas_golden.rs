//! Integridade e paridade do golden de `limitByIndexer` (`src/utils/stream-quotas.ts`).
//!
//! Cada entrada é um JSON com `op: "indexer"`. `streams[i].indexer` é a fonte
//! (`null` vira `None`); `exempt` são índices de `streams`; `indexerLimits` é o
//! objeto de cotas por fonte. A saída é o JSON dos índices mantidos (`"[0,2]"`).

mod common;

use std::collections::{HashMap, HashSet};

use adom_core::{limit_by_indexer, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/stream-quotas.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/stream-quotas.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-stream-quotas.json");

const REGISTRY_MATCH: &str = "stream-quotas/indexer";

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    assert_eq!(c["op"].as_str(), Some("indexer"), "op desconhecida");

    let owned: Vec<Option<String>> = c["streams"]
        .as_array()
        .expect("streams: array")
        .iter()
        .map(|s| s["indexer"].as_str().map(str::to_string))
        .collect();
    let indexers: Vec<Option<&str>> = owned.iter().map(|s| s.as_deref()).collect();

    let exempt: HashSet<usize> = c["exempt"]
        .as_array()
        .expect("exempt: array")
        .iter()
        .map(|i| usize::try_from(i.as_u64().expect("índice inteiro")).expect("índice"))
        .collect();

    let limits: HashMap<String, f64> = c["indexerLimits"]
        .as_object()
        .expect("indexerLimits: objeto")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_f64().expect("limite numérico")))
        .collect();

    let max = c["maxPerIndexer"].as_f64().expect("maxPerIndexer numérico");
    let kept = limit_by_indexer(&indexers, max, &exempt, &limits);
    let joined: Vec<String> = kept.iter().map(usize::to_string).collect();
    format!("[{}]", joined.join(","))
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/stream-quotas.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-stream-quotas.json");
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
    assert!(cases.len() >= 60, "golden precisa de pelo menos 60 casos");
    assert_corpus_matches(CORPUS_TEXT, &cases);
}

#[test]
fn saidas_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
