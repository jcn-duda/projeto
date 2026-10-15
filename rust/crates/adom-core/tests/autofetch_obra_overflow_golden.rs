//! Golden de `src/providers/autofetch-obra-overflow.ts` →
//! `adom-core::autofetch_obra_overflow`.
//!
//! Cobre `quality_rank` (peso da faixa, `-1` = desconhecida) e
//! `overflow_upgrade_allowed` (upgrade do teto por obra no pool BR). O
//! `expected` veio do dist vivo pelo oráculo
//! `scripts/golden/autofetch-obra-overflow-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{overflow_upgrade_allowed, quality_rank, ObraEntry, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-obra-overflow.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-obra-overflow.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-autofetch-obra-overflow.json");

const REGISTRY_MATCH: &str = "autofetch-obra-overflow/overflowUpgradeAllowed";

fn parse_entry(v: &Value) -> ObraEntry {
    ObraEntry {
        pool: v["pool"].as_str().unwrap_or("").to_string(),
        quality: v["quality"].as_str().unwrap_or("").to_string(),
        overflow: v["overflow"].as_bool().unwrap_or(false),
    }
}

fn parse_entries(v: &Value) -> Vec<ObraEntry> {
    v.as_array()
        .map(|a| a.iter().map(parse_entry).collect())
        .unwrap_or_default()
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "qualityRank" => quality_rank(c["q"].as_str().unwrap_or("")).to_string(),
        "overflowUpgradeAllowed" => {
            let entries = parse_entries(&c["entries"]);
            let pool = c["input"]["pool"].as_str().unwrap_or("");
            let quality = c["input"]["quality"].as_str().unwrap_or("");
            overflow_upgrade_allowed(&entries, pool, quality).to_string()
        }
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
    assert_eq!(m.output.path, "rust/golden/autofetch-obra-overflow.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-autofetch-obra-overflow.json"
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
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    assert_corpus_matches(CORPUS_TEXT, &cases);
}

#[test]
fn saidas_batem_com_o_golden_caso_a_caso() {
    let cases = parse_cases(JSONL_BYTES);
    assert_eq!(cases.len(), 25, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
