//! Integridade e paridade do golden de `isHomeSource`, `isNonFeature` e
//! `preHomeReleaseContradicts`.
//!
//! A saída é `"1"` ou `"0"`. `cutEnabled` e `marginMs` vêm do processo Node
//! que gerou o JSONL (default: corte ligado, margem 48h) e entram na função
//! junto com `now` e `homeReleaseAt`. O expected é o booleano do TS chamado
//! com o mesmo `now` explícito.

mod common;

use std::collections::HashSet;

use adom_core::{is_home_source, is_non_feature, pre_home_release_contradicts, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/non-feature-release.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/non-feature-release.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-non-feature-release.json");

const REGISTRY_MATCH: &str = "non-feature-release/nonFeature";

fn str_list(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("lista de strings")
        .iter()
        .map(|x| x.as_str().expect("string").to_string())
        .collect()
}

fn i64_field(v: &Value, key: &str) -> i64 {
    v[key]
        .as_i64()
        .unwrap_or_else(|| panic!("{key} cabe em i64"))
}

fn home_at(v: &Value) -> Option<i64> {
    match &v["homeReleaseAt"] {
        Value::Null => None,
        Value::Number(n) => Some(n.as_i64().expect("homeReleaseAt cabe em i64")),
        other => panic!("homeReleaseAt inválido: {other}"),
    }
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let hit = match c["op"].as_str().expect("campo op") {
        "home" => is_home_source(c["text"].as_str().expect("text")),
        "nonFeature" => {
            let texts = str_list(&c["texts"]);
            let names = str_list(&c["names"]);
            let texts_ref: Vec<&str> = texts.iter().map(String::as_str).collect();
            let names_ref: Vec<&str> = names.iter().map(String::as_str).collect();
            is_non_feature(&texts_ref, &names_ref)
        }
        "preHome" => {
            let texts = str_list(&c["texts"]);
            let texts_ref: Vec<&str> = texts.iter().map(String::as_str).collect();
            pre_home_release_contradicts(
                &texts_ref,
                home_at(&c),
                i64_field(&c, "now"),
                c["cutEnabled"].as_bool().expect("cutEnabled"),
                i64_field(&c, "marginMs"),
            )
        }
        other => panic!("op desconhecida no golden: {other}"),
    };
    if hit { "1" } else { "0" }.to_string()
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/non-feature-release.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-non-feature-release.json"
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
fn decisoes_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}

/// O processo Node deste golden está com `preHomeReleaseCut=true` (env
/// `SEARCH_PRE_HOME_RELEASE_CUT` ausente, default) e margem 172800000. O
/// JSONL só grava o que o TS devolve com o corte ligado. O ramo
/// `cut_enabled=false` não tem linha de oráculo: o TS lê o flag da config,
/// e aqui ele entra direto na função.
#[test]
fn corte_desligado_nao_contradiz_web_alem_da_margem() {
    let now: i64 = 1_759_664_000_000;
    let margin: i64 = 172_800_000;
    let home = now + margin + 86_400_000;
    let texts = ["The Odyssey 2026 1080p WEB H264 EDITH"];
    assert!(!pre_home_release_contradicts(
        &texts,
        Some(home),
        now,
        false,
        margin,
    ));
}
