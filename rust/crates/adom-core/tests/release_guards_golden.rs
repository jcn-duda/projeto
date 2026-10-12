//! Integridade e paridade do golden de `textYearsContradict`,
//! `magnetYearContradicts` e `magnetSeasonContradicts`.
//!
//! A saída é `"1"` quando contradiz e `"0"` quando não. O `expected` veio do
//! Node (`magnetYearContradicts` / `magnetSeasonContradicts`). O núcleo
//! `text_years_contradict` vê o mesmo `dn=` que o magnet: os dois têm de
//! concordar em cada caso de ano.

mod common;

use std::collections::HashSet;

use adom_core::{
    magnet_display_name, magnet_season_contradicts, magnet_year_contradicts, text_years_contradict,
    MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/release-guards.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/release-guards.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-release-guards.json");

const REGISTRY_MATCH: &str = "release-guards/releaseGuards";

/// Texto ou `None` para `null`, como o argumento chega no JS.
fn text_arg(v: &Value) -> Option<&str> {
    v.as_str()
}

fn flag(hit: bool) -> String {
    if hit { "1" } else { "0" }.to_string()
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let magnet = text_arg(&c["magnet"]);
    let magnet_uri = text_arg(&c["magnetUri"]);
    let guid = text_arg(&c["guid"]);
    match c["op"].as_str().expect("campo op") {
        "year" => {
            let year = c["year"].as_i64().expect("year numérico");
            let by_magnet = magnet_year_contradicts(magnet, magnet_uri, guid, year);
            // O oráculo mediu o magnet. O núcleo recebe o dn= daquele magnet.
            let dn = magnet_display_name(magnet, magnet_uri, guid);
            assert_eq!(
                text_years_contradict(&dn, year),
                by_magnet,
                "núcleo e magnet divergiram: {input}"
            );
            flag(by_magnet)
        }
        "season" => {
            let season = c["season"].as_i64().expect("season numérica");
            let episode = c["episode"].as_i64();
            flag(magnet_season_contradicts(
                magnet, magnet_uri, guid, season, episode,
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
    assert_eq!(m.output.path, "rust/golden/release-guards.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-release-guards.json");
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
fn vereditos_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
