//! Integridade e paridade do golden de `matchesEpisodeWorkIdentity` e
//! `matchesGlobalSeriesNoMarker` (guardas de identidade de obra em release
//! GLOBAL). Cada entrada é um JSON com `op=episodeWorkIdentity` ou
//! `globalSeriesNoMarker`. `allNames` `null` vira `None`, lista (mesmo vazia)
//! vira `Some`. `cutTail` `false` vira `cut_tail=false`; default é `true`.
//!
//! O corpus foi gerado manualmente a partir dos casos de teste das funções
//! TypeScript em `src/utils/release-title-rules.ts`. Os valores esperados
//! foram traçados caso a caso.

mod common;

use std::collections::HashSet;

use adom_core::{matches_episode_work_identity, matches_global_series_no_marker, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/episode-series-matching.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/episode-series-matching.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-episode-series-matching.json");

const REGISTRY_EPISODE_WORK: &str = "episode-series-matching/matchesEpisodeWorkIdentity";
const REGISTRY_GLOBAL_SERIES: &str = "episode-series-matching/matchesGlobalSeriesNoMarker";

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

fn bit(v: bool) -> String {
    u8::from(v).to_string()
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let op = c["op"].as_str().expect("op");
    let cut_tail = c["cutTail"].as_bool().unwrap_or(true);

    match op {
        "episodeWorkIdentity" => {
            let title = c["title"].as_str().expect("title");
            let all_names = all_names_of(&c["allNames"]);
            let tokens = if c["tokens"].is_null() {
                None
            } else {
                c["tokens"].as_array().map(|_| strings(&c["tokens"]))
            };
            let universe_tokens = if c["universeTokens"].is_null() {
                None
            } else {
                c["universeTokens"]
                    .as_array()
                    .map(|_| strings(&c["universeTokens"]))
            };
            bit(matches_episode_work_identity(
                title,
                all_names.as_deref(),
                tokens.as_deref(),
                universe_tokens.as_deref(),
                cut_tail,
            ))
        }
        "globalSeriesNoMarker" => {
            let title = c["title"].as_str().expect("title");
            let tokens = strings(&c["tokens"]);
            let universe = strings(&c["universe"]);
            bit(matches_global_series_no_marker(
                title, &tokens, &universe, cut_tail,
            ))
        }
        other => panic!("op desconhecida: {other}"),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(
        m.registry,
        vec![
            REGISTRY_EPISODE_WORK.to_string(),
            REGISTRY_GLOBAL_SERIES.to_string()
        ]
    );
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/episode-series-matching.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-episode-series-matching.json"
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
