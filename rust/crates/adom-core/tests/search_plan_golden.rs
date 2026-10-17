//! Paridade do golden de `search-plan` (F-1): plano da coleta do Jackett.
//!
//! O golden é gerado no worktree `../adom-esm` (o TS original) e commitado aqui;
//! este teste NÃO reimplementa o oráculo, ele consome o `.jsonl`.
//!
//! # Comparação
//!
//! - Resultados ESCALARES (strings e `null` de `ptSweepQuery`,
//!   `ptSweepQueryFor`, `dubbedSweepQueryFor`) são comparados byte a byte.
//! - O PLANO é uma lista de objetos com propriedades CONDICIONAIS; a comparação
//!   é por `serde_json::Value`, que é insensível à ordem das chaves (a ordem não
//!   é contrato do `deepEqual` do Node) e sensível ao CONJUNTO de chaves — é
//!   exatamente o que pega "propriedade que não devia existir".

mod common;

use std::collections::HashSet;

use adom_core::{
    dubbed_sweep_query_for, live_indexers, plan_jackett_queries, pt_sweep_indexers, pt_sweep_query,
    pt_sweep_query_for, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex, GoldenCase};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/search-plan.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/search-plan.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-search-plan.json");

const REGISTRY_MATCH: &str = "search-plan/searchPlan";

/// Lista de strings (campo ausente ou `null` conta como lista vazia, como o
/// default `[]` do TS).
fn str_list(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|x| x.as_str().expect("lista de strings").to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn render(input: &str) -> Value {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let s = |key: &str| c[key].as_str();
    match c["op"].as_str().expect("op presente") {
        "plan" => serde_json::to_value(plan_jackett_queries(
            c["query"].as_str().expect("query"),
            s("ptQuery"),
            &str_list(&c["selectedIndexers"]),
            &str_list(&c["ptBrIndexers"]),
            &str_list(&c["isolateIndexers"]),
            s("sweepQuery"),
            s("originalQuery"),
            s("multiWorkQuery"),
        ))
        .expect("plano serializa"),
        "ptSweepIndexers" => serde_json::to_value(pt_sweep_indexers(
            &str_list(&c["selectedIndexers"]),
            &str_list(&c["ptBrIndexers"]),
            &str_list(&c["indexOnlyIndexers"]),
        ))
        .expect("lista serializa"),
        "liveIndexers" => serde_json::to_value(live_indexers(
            &str_list(&c["selectedIndexers"]),
            &str_list(&c["indexOnlyIndexers"]),
            &str_list(&c["exemptIndexers"]),
        ))
        .expect("lista serializa"),
        "ptSweepQuery" => serde_json::to_value(pt_sweep_query(s("titlePt"))).expect("string"),
        "ptSweepQueryFor" => {
            let titles = &c["titles"];
            serde_json::to_value(pt_sweep_query_for(
                titles["pt"].as_str(),
                titles["original"].as_str(),
            ))
            .expect("opcional serializa")
        }
        "dubbedSweepQueryFor" => {
            let titles = &c["titles"];
            serde_json::to_value(dubbed_sweep_query_for(
                titles["pt"].as_str(),
                titles["en"].as_str(),
                titles["original"].as_str(),
            ))
            .expect("opcional serializa")
        }
        other => panic!("op desconhecida: {other}"),
    }
}

/// Escalar (string/`null`) bate byte a byte; objeto/lista batem por `Value`
/// (ordem de chave insensível — ver o cabeçalho).
fn assert_case(case: &GoldenCase) {
    let obtido = render(&case.input);
    let esperado: Value = serde_json::from_str(&case.expected).expect("expected é JSON");
    match &esperado {
        Value::String(s) => assert_eq!(
            obtido.as_str(),
            Some(s.as_str()),
            "caso {} divergiu\nentrada:  {}\nesperado: {:?}\nobtido:   {:?}",
            case.id,
            case.input,
            s,
            obtido
        ),
        Value::Null => assert!(
            obtido.is_null(),
            "caso {} esperava null, veio {obtido:?}",
            case.id
        ),
        _ => assert_eq!(
            obtido, esperado,
            "caso {} divergiu\nentrada:  {}",
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
    assert_eq!(m.output.path, "rust/golden/search-plan.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-search-plan.json");
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
fn plano_bate_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        assert_case(&case);
    }
}
