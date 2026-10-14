//! Integridade e paridade do golden de `episode-matching` (`matchesEpisode`,
//! `isSeasonPackRelease`, `isSeasonPackFillEligible`).
//!
//! Cada entrada é um JSON com `op`. As operações:
//! - `matches`: devolve `1` ou `0` (release casa com o episódio?).
//! - `pack`: devolve `1` ou `0` (release é pack da temporada?).
//! - `fill`: devolve `1` ou `0` (pack é eligible para season fill?).

mod common;

use std::collections::HashSet;

use adom_core::MANIFEST_FORMAT;
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/episode-matching.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/episode-matching.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-episode-matching.json");

const REGISTRY_MATCH: &str = "episode-matching/matching";

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let title = c["title"].as_str().expect("campo title");
    let season = c["season"].as_i64();
    match c["op"].as_str().expect("campo op") {
        "matches" => {
            let episode = c["episode"].as_i64();
            let result = adom_core::matches_episode(title, season, episode);
            u8::from(result).to_string()
        }
        "pack" => {
            let result = adom_core::is_season_pack_release(title, season);
            u8::from(result).to_string()
        }
        "fill" => {
            let result = adom_core::is_season_pack_fill_eligible(title, season);
            u8::from(result).to_string()
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
    assert_eq!(m.output.path, "rust/golden/episode-matching.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-episode-matching.json");
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
