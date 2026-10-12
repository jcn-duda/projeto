//! Integridade e paridade do golden de `src/utils/multiwork-pack.ts`.
//!
//! Cada entrada é um JSON com `op`. `item` é o RawItem (pode ser null): o
//! fallback `title || Title` e `magnet || MagnetUri` vem daqui, como no TS.
//! Ano `null` chega como `""` (o `String(x ?? '')` do JS); número vira texto.

mod common;

use std::collections::HashSet;

use adom_core::{
    admits_multi_work_pack, collection_root, collection_root_tokens, covers_year, pack_year_source,
    MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/multiwork-pack.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/multiwork-pack.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-multiwork-pack.json");

const REGISTRY_MATCH: &str = "multiwork-pack/admission";

fn bit(v: bool) -> String {
    u8::from(v).to_string()
}

/// `String(x ?? '')` do JS para o ano do catálogo.
fn year_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

/// `item?.first || item?.second || ''`: a primeira string não vazia.
fn field<'a>(item: &'a Value, first: &str, second: &str) -> &'a str {
    [first, second]
        .iter()
        .filter_map(|key| item[*key].as_str())
        .find(|s| !s.is_empty())
        .unwrap_or("")
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let item = &c["item"];
    match c["op"].as_str().expect("campo op") {
        "root" => collection_root(c["name"].as_str().unwrap_or("")),
        "rootTokens" => collection_root_tokens(c["name"].as_str().unwrap_or("")).join(" "),
        "covers" => bit(covers_year(
            c["text"].as_str().unwrap_or(""),
            &year_text(&c["year"]),
        )),
        "evidence" => pack_year_source(
            field(item, "title", "Title"),
            field(item, "magnet", "MagnetUri"),
        ),
        "admits" => {
            let names: Vec<String> = c["names"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .map(|n| n.as_str().unwrap_or("").to_string())
                        .collect()
                })
                .unwrap_or_default();
            bit(admits_multi_work_pack(
                field(item, "title", "Title"),
                field(item, "magnet", "MagnetUri"),
                c["multiWork"]["root"].as_str(),
                &year_text(&c["year"]),
                c["isSeries"] == Value::Bool(true),
                &names,
            ))
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
    assert_eq!(m.output.path, "rust/golden/multiwork-pack.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-multiwork-pack.json");
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
fn golden_tem_uns_e_zeros_nos_booleanos() {
    let outputs: Vec<String> = parse_cases(JSONL_BYTES)
        .into_iter()
        .map(|case| case.expected)
        .collect();
    assert!(outputs.iter().any(|o| o == "1"), "sem caso positivo");
    assert!(outputs.iter().any(|o| o == "0"), "sem caso negativo");
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
