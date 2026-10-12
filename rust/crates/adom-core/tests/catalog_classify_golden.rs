//! Integridade e paridade do golden da classificação durável de
//! `catalog-classify.ts`: `foreignProofLabel` (op `label`), `classifyByTitle`
//! (op `title`) e `classifyWithEvidence` (op `evidence`).
//!
//! A saída é a string canônica medida no oracle Node: `cena`/`audio`/`sim`
//! para `label`, e `bucket|audio|foreignProof|ptProof` para as duas
//! classificações. As listas calibradas (`ptMarkers`/`enGroups`) vêm do bloco
//! `config` do corpus: as funções Rust recebem-nas por parâmetro.

mod common;

use std::collections::HashSet;

use adom_core::{classify_by_title, classify_with_evidence, foreign_proof_label, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/catalog-classify.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/catalog-classify.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-catalog-classify.json");

const REGISTRY_MATCH: &str = "catalog-classify/catalogClassify";

struct Config {
    pt_markers: Vec<String>,
    en_groups: Vec<String>,
}

fn config() -> Config {
    let corpus: Value = serde_json::from_str(CORPUS_TEXT).expect("corpus JSON válido");
    let cfg = &corpus["config"];
    let strings = |key: &str| -> Vec<String> {
        cfg[key]
            .as_array()
            .unwrap_or_else(|| panic!("config.{key}: array"))
            .iter()
            .map(|v| v.as_str().expect("config: string").to_string())
            .collect()
    };
    Config {
        pt_markers: strings("ptMarkers"),
        en_groups: strings("enGroups"),
    }
}

fn proof_line(bucket: &str, audio: &str, foreign_proof: &str, pt_proof: &str) -> String {
    format!("{bucket}|{audio}|{foreign_proof}|{pt_proof}")
}

fn render(input: &str, cfg: &Config) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let pt: Vec<&str> = cfg.pt_markers.iter().map(String::as_str).collect();
    let en: Vec<&str> = cfg.en_groups.iter().map(String::as_str).collect();
    match c["op"].as_str().expect("campo op") {
        "label" => {
            let candidates: Vec<&str> = c["candidates"]
                .as_array()
                .expect("campo candidates")
                .iter()
                .map(|v| v.as_str().expect("candidate string"))
                .collect();
            foreign_proof_label(&candidates, &pt, &en).to_string()
        }
        "title" => {
            let p = classify_by_title(c["filename"].as_str().expect("campo filename"), &pt, &en);
            proof_line(p.bucket, p.audio, p.foreign_proof, p.pt_proof)
        }
        "evidence" => {
            let p = classify_with_evidence(
                c["filename"].as_str().expect("campo filename"),
                c["evidence"].as_str(),
                &pt,
                &en,
            );
            proof_line(p.bucket, p.audio, p.foreign_proof, p.pt_proof)
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
    assert_eq!(m.output.path, "rust/golden/catalog-classify.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-catalog-classify.json");
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
fn predicados_batem_com_o_golden_caso_a_caso() {
    let cfg = config();
    let cases = parse_cases(JSONL_BYTES);
    // Catraca de contagem: 14 de `label` + 20 de `title` + 16 de `evidence`.
    // Uma regeneração que encolha o corpus junto com o manifest não passa aqui.
    assert_eq!(cases.len(), 50, "contagem de casos do corpus mudou");
    for case in cases {
        let obtido = render(&case.input, &cfg);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
