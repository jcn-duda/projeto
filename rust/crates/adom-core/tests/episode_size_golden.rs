//! Golden de `src/providers/episode-size.ts` → `adom-core::episode_size`.
//!
//! Cobre `streamTitleBytes` e `streamSizeLabel` (o `parseSizeLabel` do TS não é
//! exportado: entra indireto pelos casos, com teste unitário no módulo).
//! O `expected` veio do dist vivo pelo oráculo `scripts/golden/episode-size-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{parse_size_label, stream_size_label, stream_title_bytes, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/episode-size.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/episode-size.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-episode-size.json");

const REGISTRY_MATCH: &str = "episode-size/episodeSize";

/// Formata f64 como inteiro (sem casas decimais) — paridade com `String(n)` do JS.
fn num_str(n: f64) -> String {
    if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "streamTitleBytes" => {
            let title = c["title"].as_str();
            num_str(stream_title_bytes(title))
        }
        "streamSizeLabel" => match c["title"].as_str().and_then(stream_size_label) {
            Some(label) => label,
            None => "null".to_string(),
        },
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
    assert_eq!(m.output.path, "rust/golden/episode-size.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-episode-size.json");
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
    let cases = parse_cases(JSONL_BYTES);
    assert_eq!(cases.len(), 52, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}

// `parseSizeLabel` não é exportada pelo oráculo TS; cobertura direta aqui,
// com os mesmos fallbacks de 0 do TS (unidade fora do mapa, valor não numérico).
#[test]
fn parse_size_label_paridade_com_o_ts() {
    assert_eq!(parse_size_label("1.5 GB"), 1_610_612_736.0);
    assert_eq!(parse_size_label("1 B"), 1.0);
    assert_eq!(parse_size_label("1 KB"), 1024.0);
    assert_eq!(parse_size_label("1 MB"), 1_048_576.0);
    assert_eq!(parse_size_label("1 TB"), 1_099_511_627_776.0);
    assert_eq!(parse_size_label("1.55GB"), 0.0);
    assert_eq!(parse_size_label("abc GB"), 0.0);
    assert_eq!(parse_size_label("1.5"), 0.0);
    assert_eq!(parse_size_label("1.5 XB"), 0.0);
    assert_eq!(parse_size_label("sem espaço nenhum"), 0.0);
}
