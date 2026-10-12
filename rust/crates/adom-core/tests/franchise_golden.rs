//! Integridade e paridade do golden das guardas de franquia e dos helpers de
//! release-name-matching que elas usam.
//!
//! Cada entrada é um JSON com `op`. Ano `null` chega como `""`, o mesmo que o
//! JS faz com `String(x ?? '')`. `own` `null` vira `None`, e lista (mesmo
//! vazia) vira `Some`.

mod common;

use std::collections::HashSet;

use adom_core::{
    franchise_base_contradicts, franchise_extension_contradicts, is_multi_work_collection,
    name_coverage_tokens, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/franchise.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/franchise.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-franchise.json");

const REGISTRY_MATCH: &str = "franchise/guards";

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("lista de strings")
        .iter()
        .map(|x| x.as_str().expect("string").to_string())
        .collect()
}

fn year_text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn bit(v: bool) -> String {
    u8::from(v).to_string()
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let title = c["title"].as_str().unwrap_or("");
    let own: Option<Vec<String>> = if c["own"].is_null() {
        None
    } else {
        Some(strings(&c["own"]))
    };
    match c["op"].as_str().expect("campo op") {
        "base" => bit(franchise_base_contradicts(
            title,
            own.as_deref(),
            c["name"].as_str().expect("nome"),
            &year_text(&c["year"]),
        )),
        "extension" => bit(franchise_extension_contradicts(
            title,
            own.as_deref(),
            c["name"].as_str().expect("nome"),
            &strings(&c["allNames"]),
            &year_text(&c["year"]),
        )),
        "coverage" => name_coverage_tokens(c["name"].as_str().expect("nome")).join(" "),
        "multiWork" => bit(is_multi_work_collection(title)),
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
    assert_eq!(m.output.path, "rust/golden/franchise.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-franchise.json");
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
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
