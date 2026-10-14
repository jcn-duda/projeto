//! Integridade e paridade do golden de `episode-parse` (`parseTitleSeasonEpisode`
//! e `seasonCoverageExcludes`).
//!
//! Cada entrada é um JSON com `op`. `parse` devolve `s=… e=… c=0|1 p=0|1`
//! (listas na ordem de inserção, separadas por vírgula; `c` é `complete` e `p` é
//! `seasonPack`). `excludes` devolve `1` ou `0`.

mod common;

use std::collections::HashSet;

use adom_core::{
    parse_title_season_episode, season_coverage_excludes, ParsedSeasonEpisode, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/episode-parse.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/episode-parse.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-episode-parse.json");

const REGISTRY_MATCH: &str = "episode-matching/parse";

fn join(values: &[i64]) -> String {
    values
        .iter()
        .map(|n| n.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn format_parsed(p: &ParsedSeasonEpisode) -> String {
    format!(
        "s={} e={} c={} p={}",
        join(&p.seasons),
        join(&p.episodes),
        u8::from(p.complete),
        u8::from(p.season_pack)
    )
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let title = c["title"].as_str().expect("campo title");
    match c["op"].as_str().expect("campo op") {
        "parse" => format_parsed(&parse_title_season_episode(title)),
        "excludes" => {
            let parsed = parse_title_season_episode(title);
            let season = c["season"].as_i64();
            if season_coverage_excludes(&parsed, season) {
                "1".into()
            } else {
                "0".into()
            }
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
    assert_eq!(m.output.path, "rust/golden/episode-parse.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-episode-parse.json");
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
