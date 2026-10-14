//! Integridade e paridade do golden da apresentação de áudio:
//! `strip_quality_tag_blob`, `audio_from_title` e `looks_pt_br`.
//!
//! O `input` de cada caso é um JSON (`{"op":…,"title":…}`); o `op` seleciona a
//! função, como o corpus. A saída é a string REAL do TS — o título recortado
//! (`strip`), o rótulo de áudio (`audio`) ou o bit `0|1` (`looks`). O porte Rust
//! não replica lógica do Node: só reproduz a saída commitada no golden.

mod common;

use std::collections::HashSet;

use adom_core::{audio_from_title, looks_pt_br, strip_quality_tag_blob, MANIFEST_FORMAT};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/audio-presentation.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/audio-presentation.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-audio-presentation.json");

const REGISTRY_MATCH: &str = "audio-presentation/audioQualityPresentation";

fn bit(v: bool) -> &'static str {
    if v {
        "1"
    } else {
        "0"
    }
}

/// O `input` do caso é um JSON com `op` (`strip`|`audio`|`looks`) e `title`; a
/// saída é a string REAL da função escolhida.
fn render(input: &str) -> String {
    let req: serde_json::Value = serde_json::from_str(input).expect("input do caso é JSON");
    let op = req["op"].as_str().expect("op precisa ser string");
    let title = req["title"].as_str().expect("title precisa ser string");
    match op {
        "strip" => strip_quality_tag_blob(title).to_string(),
        "audio" => audio_from_title(title).to_string(),
        "looks" => bit(looks_pt_br(title)).to_string(),
        outra => panic!("op desconhecida: {outra}"),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/audio-presentation.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-audio-presentation.json"
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
