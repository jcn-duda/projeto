//! Golden de `src/providers/autofetch-marker.ts` → `adom-core::autofetch_marker`.
//!
//! Cobre a parte PURA do marker do Chupim: `marker_key`, `marker_value` (com
//! paridade byte a byte do `JSON.stringify`), `marker_transfer_id` e
//! `marker_obra`. Os leitores no fonte bebem do cache; aqui a interpretação do
//! valor JÁ lido é o que se compara (`MarkerValue::from_json`). O `expected`
//! veio do dist vivo pelo oráculo `scripts/golden/autofetch-marker-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{
    marker_key, marker_obra, marker_transfer_id, marker_value, MarkerMeta, MarkerValue,
    MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-marker.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-marker.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-autofetch-marker.json");

const REGISTRY_MATCH: &str = "autofetch-marker/markerValue";

/// `now_ms` fixo: todo caso com `meta` traz `acceptedAt` finito, então o
/// fallback nunca é exercitado — mantém o golden determinístico.
const NOW_MS: i64 = 0;

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(|s| s.to_string())
}

fn parse_meta(v: &Value) -> Option<MarkerMeta> {
    if v.is_null() {
        return None;
    }
    Some(MarkerMeta {
        pool: opt_str(v, "pool"),
        obra: opt_str(v, "obra"),
        accepted_at: v["acceptedAt"].as_i64(),
        title: opt_str(v, "title"),
        br: v["br"].as_bool().unwrap_or(false),
        dubbed: v["dubbed"].as_bool().unwrap_or(false),
    })
}

/// `Option<&str>` → a string ou "null" (o `reason` do oráculo).
fn reason(v: Option<&str>) -> String {
    v.map(|s| s.to_string())
        .unwrap_or_else(|| "null".to_string())
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "markerKey" => marker_key(
            c["adapterId"].as_str().unwrap_or(""),
            c["account"].as_str().unwrap_or(""),
            c["infoHash"].as_str().unwrap_or(""),
        ),
        "markerValue" => {
            let accepted = c["accepted"].as_str().unwrap_or("");
            let meta = parse_meta(&c["meta"]);
            marker_value(accepted, meta.as_ref(), NOW_MS).to_json_string()
        }
        "markerTransferId" => {
            let value = MarkerValue::from_json(&c["value"]);
            reason(marker_transfer_id(&value))
        }
        "markerObra" => {
            let value = MarkerValue::from_json(&c["value"]);
            reason(marker_obra(&value))
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
    assert_eq!(m.output.path, "rust/golden/autofetch-marker.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-autofetch-marker.json");
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
    assert_eq!(cases.len(), 24, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
