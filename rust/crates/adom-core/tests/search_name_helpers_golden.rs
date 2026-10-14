//! Integridade e paridade do golden de `search-name-helpers`.
//!
//! A saída comparada é `serde_json::to_string` do resultado de cada função — o
//! mesmo texto que o `JSON.stringify` do Node (inteiro exato e texto UTF-8 cru).
//! Cada entrada do corpus traz `op` e os argumentos; o teste despacha para a
//! função Rust correspondente e compara caso a caso com o `dist` vivo.

mod common;

use std::collections::HashSet;

use adom_core::{
    build_search_query, mark_debrid_name, matches_quality_filter, numeral_search_variant,
    parse_stremio_id, resolve_original_step_name, resolve_search_names, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/search-name-helpers.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/search-name-helpers.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-search-name-helpers.json");

const REGISTRY: [&str; 7] = [
    "search-name-helpers/resolveSearchNames",
    "search-name-helpers/resolveOriginalStepName",
    "search-name-helpers/parseStremioId",
    "search-name-helpers/buildSearchQuery",
    "search-name-helpers/numeralSearchVariant",
    "search-name-helpers/markDebridName",
    "search-name-helpers/matchesQualityFilter",
];

/// `Option<String>` como o TS devolve (string ou `null`).
fn opt(v: Option<String>) -> Value {
    v.map(Value::String).unwrap_or(Value::Null)
}

/// `filters ?? undefined` do oráculo: null/ausente não filtram; lista vazia também não.
fn filters(c: &Value) -> Option<Vec<String>> {
    c["filters"].as_array().map(|a| {
        a.iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    })
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let out = match c["op"].as_str().expect("campo op") {
        "resolveSearchNames" => resolve_search_names(&c),
        "resolveOriginalStepName" => opt(resolve_original_step_name(
            c["original"].as_str(),
            c["primaryName"].as_str(),
        )),
        "parseStremioId" => parse_stremio_id(c["id"].as_str().expect("campo id")),
        "buildSearchQuery" => Value::String(build_search_query(&c["meta"], &c)),
        "numeralSearchVariant" => opt(numeral_search_variant(
            c["query"].as_str().expect("campo query"),
        )),
        "markDebridName" => Value::String(mark_debrid_name(
            c["name"].as_str().unwrap_or(""),
            c["short"].as_str().unwrap_or(""),
            c["cached"].as_bool().unwrap_or(false),
        )),
        "matchesQualityFilter" => Value::Bool(matches_quality_filter(
            c["title"].as_str().unwrap_or(""),
            filters(&c).as_deref(),
        )),
        other => panic!("op desconhecida no golden: {other}"),
    };
    serde_json::to_string(&out).expect("saída serializável")
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, REGISTRY.map(str::to_string).to_vec());
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/search-name-helpers.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-search-name-helpers.json"
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
fn casos_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
