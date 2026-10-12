//! Paridade exaustiva da classe de `LATIN_LETTER_RE` (`[\p{Script=Latin}\p{M}]`).
//!
//! O golden lista, em hexadecimal, os intervalos de code points de 0 a 10FFFF
//! que o TS (Node, Unicode 17) classifica como latinos ou marcas. Esta varredura
//! recalcula os mesmos intervalos no porte Rust, código a código, sem amostra.

use adom_core::{is_non_latin_token, MANIFEST_FORMAT};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/matching-latin-ranges.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/matching-latin-ranges.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-matching-latin-ranges.json");

const REGISTRY_MATCH: &str = "matching-latin-ranges/codepoints";

#[derive(Debug, Deserialize)]
struct Manifest {
    format: String,
    registry: Vec<String>,
    output: OutputRef,
}

#[derive(Debug, Deserialize)]
struct OutputRef {
    sha256: String,
    lines: usize,
}

#[derive(Debug, Deserialize)]
struct GoldenCase {
    id: String,
    expected: String,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.as_slice() {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Intervalos de code points que casam, no formato do golden (`a-b` ou `a`).
fn latin_ranges() -> String {
    let mut ranges: Vec<String> = Vec::new();
    let mut start: Option<u32> = None;
    let flush = |ranges: &mut Vec<String>, s: u32, end: u32| {
        ranges.push(if s == end {
            format!("{s:x}")
        } else {
            format!("{s:x}-{end:x}")
        });
    };
    for cp in 0..=0x10_ffffu32 {
        // Surrogates não são `char`: o TS também não os inclui na varredura.
        let inside = match char::from_u32(cp) {
            Some(c) => !is_non_latin_token(c.encode_utf8(&mut [0; 4])),
            None => false,
        };
        match (inside, start) {
            (true, None) => start = Some(cp),
            (false, Some(s)) => {
                flush(&mut ranges, s, cp - 1);
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        flush(&mut ranges, s, 0x10_ffff);
    }
    ranges.join(" ")
}

#[test]
fn manifest_registro_formato_e_hash_batem() {
    let m: Manifest = serde_json::from_str(MANIFEST_TEXT).expect("manifest JSON válido");
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, 1);
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    let corpus: serde_json::Value = serde_json::from_str(CORPUS_TEXT).expect("corpus JSON válido");
    assert_eq!(corpus["cases"].as_array().map(Vec::len), Some(1));
}

#[test]
fn intervalos_latinos_batem_com_o_golden_em_todo_o_unicode() {
    let text = std::str::from_utf8(JSONL_BYTES).expect("UTF-8");
    let case: GoldenCase = serde_json::from_str(text.trim_end()).expect("uma linha válida");
    assert_eq!(case.id, "lr-001");
    assert_eq!(latin_ranges(), case.expected);
}
