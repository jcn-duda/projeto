//! Golden de `src/providers/autofetch-expired.ts` →
//! `adom-core::autofetch_expired`.
//!
//! Cobre `expired_removal_allowed` — a guarda de posse do expired-unready.
//! O `expected` veio do oráculo `scripts/golden/autofetch-expired-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{expired_removal_allowed, ExpiredFacts, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-expired.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-expired.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-autofetch-expired.json");

const REGISTRY_MATCH: &str = "autofetch-expired/expiredRemovalAllowed";

fn bool_field(v: &Value, key: &str) -> bool {
    v.get(key).and_then(|val| val.as_bool()).unwrap_or(false)
}

fn parse_facts(v: &Value) -> ExpiredFacts {
    ExpiredFacts {
        hash_empty: bool_field(v, "hashEmpty"),
        is_cleanup_protected: bool_field(v, "isCleanupProtected"),
        adapter_is_alldebrid: bool_field(v, "adapterIsAlldebrid"),
        has_marker: bool_field(v, "hasMarker"),
        has_adsub: bool_field(v, "hasAdsub"),
        has_snapshot: bool_field(v, "hasSnapshot"),
        in_snapshot: bool_field(v, "inSnapshot"),
    }
}

fn render(input: &str) -> String {
    let v: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let facts = parse_facts(&v);
    if expired_removal_allowed(&facts) {
        "1"
    } else {
        "0"
    }
    .to_string()
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/autofetch-expired.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-autofetch-expired.json"
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
    let cases = parse_cases(JSONL_BYTES);
    assert_eq!(cases.len(), 15, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
