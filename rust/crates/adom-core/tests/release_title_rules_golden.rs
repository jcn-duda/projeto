//! Integridade e paridade do golden das funções puras de
//! `src/utils/release-title-rules.ts`: `matchesTitleStructure`,
//! `shortNameIdentity` e `matchesShortNameIdentity`.
//!
//! Cada entrada é um JSON com `op`. Ano `null` chega como `""` (o TS usa
//! `null`, que vira `""` em `String(year ?? '')`). `own` `null` vira `None`, e
//! lista (mesmo vazia) vira `Some`.

mod common;

use std::collections::HashSet;

use adom_core::{
    matches_short_name_identity, matches_title_structure, short_name_identity, ShortNameIdentity,
    MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/release-title-rules.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/release-title-rules.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-release-title-rules.json");

const REGISTRY_MATCH: &str = "release-title-rules/guards";

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("lista de strings")
        .iter()
        .map(|x| x.as_str().expect("string").to_string())
        .collect()
}

fn own_of(v: &Value) -> Option<Vec<String>> {
    if v.is_null() {
        None
    } else {
        Some(strings(v))
    }
}

/// Ano `null` ou ausente vira `""`, como o `String(year ?? '')` do TS.
fn year_text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn bit(v: bool) -> String {
    u8::from(v).to_string()
}

/// Forma textual do `ShortNameIdentity`, a mesma que o gerador grava.
fn identity_text(check: &ShortNameIdentity) -> String {
    match check {
        ShortNameIdentity::Skip => "skip".to_string(),
        ShortNameIdentity::NoToken => "no-token".to_string(),
        ShortNameIdentity::Prefix { want, run } => format!("prefix|{want}|{}", run.join(" ")),
    }
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let name = c["name"].as_str().expect("nome");
    match c["op"].as_str().expect("campo op") {
        "shortName" => identity_text(&short_name_identity(name)),
        "identity" => {
            let check = short_name_identity(name);
            let own = own_of(&c["own"]);
            let dn = c["dn"].as_str().unwrap_or("");
            bit(matches_short_name_identity(
                c["title"].as_str().unwrap_or(""),
                &check,
                own.as_deref(),
                dn,
            ))
        }
        "structure" => {
            let own = own_of(&c["own"]);
            bit(matches_title_structure(
                c["title"].as_str().unwrap_or(""),
                name,
                &year_text(&c["year"]),
                c["isSeries"].as_bool().unwrap_or(false),
                own.as_deref(),
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
    assert_eq!(m.output.path, "rust/golden/release-title-rules.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-release-title-rules.json"
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
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}

#[test]
fn casos_cobrem_zero_e_um_nas_funcoes_booleanas() {
    let mut zeros = 0;
    let mut uns = 0;
    for case in parse_cases(JSONL_BYTES) {
        let op = serde_json::from_str::<Value>(&case.input).expect("JSON")["op"]
            .as_str()
            .expect("op")
            .to_string();
        if op == "shortName" {
            continue;
        }
        match case.expected.as_str() {
            "0" => zeros += 1,
            "1" => uns += 1,
            other => panic!("saída booleana inesperada: {other}"),
        }
    }
    assert!(zeros > 0 && uns > 0, "golden precisa de 0 e de 1");
}
