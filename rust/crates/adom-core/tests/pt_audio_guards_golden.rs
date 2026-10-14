//! Integridade e paridade do golden das guardas de áudio explícito:
//! `explicit_pt_audio` e `has_explicit_foreign_audio` (a lista MÍNIMA).
//!
//! A saída por caso é `explicit=<0|1> foreign=<0|1>`, o booleano do JS virado
//! em bit, na mesma ordem em que o oráculo do dist as mede.

mod common;

use std::collections::HashSet;

use adom_core::{explicit_pt_audio, has_explicit_foreign_audio, MANIFEST_FORMAT};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/pt-audio-guards.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/pt-audio-guards.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-pt-audio-guards.json");

const REGISTRY_MATCH: &str = "pt-audio-guards/audioQualityGuards";

fn bit(v: bool) -> &'static str {
    if v {
        "1"
    } else {
        "0"
    }
}

/// O `input` do caso é o próprio título (string), não JSON.
fn render(input: &str) -> String {
    let explicit = explicit_pt_audio(input);
    let foreign = has_explicit_foreign_audio(input);
    format!("explicit={} foreign={}", bit(explicit), bit(foreign))
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/pt-audio-guards.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-pt-audio-guards.json");
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
fn predicados_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
