//! Integridade e paridade do golden de `matchesBrTitle` (filtro estrito de
//! título BR). Cada entrada é um JSON com `op=brTitle`. Ano `null` chega como
//! `""` (o TS usa `String(year ?? '')`). `allNames` `null` vira `None`, lista
//! (mesmo vazia) vira `Some`.
//!
//! O corpus foi gerado manualmente a partir dos testes TypeScript em
//! `test/br-title.test.ts` e `test/br-title-edition.test.ts`. Os valores
//! esperados foram traçados caso a caso.

mod common;

use std::collections::HashSet;

use adom_core::{matches_br_title, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/matches-br-title.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/matches-br-title.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-matches-br-title.json");

const REGISTRY_MATCH: &str = "matches-br-title/matchesBrTitle";

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("lista de strings")
        .iter()
        .map(|x| x.as_str().expect("string").to_string())
        .collect()
}

fn all_names_of(v: &Value) -> Option<Vec<String>> {
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

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let title = c["title"].as_str().expect("title");
    let name = c["name"].as_str().expect("name");
    let year = year_text(&c["year"]);
    let is_series = c["isSeries"].as_bool().unwrap_or(false);
    let all_names = all_names_of(&c["allNames"]);
    // cut_tail=true é o default do config TS (titlePrecisionTailCut !== false).
    let cut_tail = c["cutTail"].as_bool().unwrap_or(true);
    bit(matches_br_title(
        title,
        name,
        &year,
        is_series,
        all_names.as_deref(),
        None,
        None,
        cut_tail,
    ))
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/matches-br-title.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-matches-br-title.json"
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
            "caso {} divergiu: esperado={}, obtido={} | {}",
            case.id, case.expected, obtido, case.input
        );
    }
}

#[test]
fn casos_cobrem_zero_e_um() {
    let mut zeros = 0;
    let mut uns = 0;
    for case in parse_cases(JSONL_BYTES) {
        match case.expected.as_str() {
            "0" => zeros += 1,
            "1" => uns += 1,
            other => panic!("saída booleana inesperada: {other}"),
        }
    }
    assert!(zeros > 0 && uns > 0, "golden precisa de 0 e de 1");
}
