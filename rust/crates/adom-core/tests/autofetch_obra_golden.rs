//! Golden de `src/providers/autofetch-obra.ts` →
//! `adom-core::autofetch_obra`.
//!
//! Cobre `obra_identity`, `obra_key` e `obra_digest` — as três funções
//! exportadas do módulo TS que produzem saída determinística a partir da
//! entrada. O `expected` veio do dist vivo pelo oráculo
//! `scripts/golden/autofetch-obra-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{obra_digest, obra_identity, obra_key, ObraIdentityInput, MANIFEST_FORMAT};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-obra.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-obra.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-autofetch-obra.json");

const REGISTRY_MATCH: &str = "autofetch-obra/obraIdentity";

/// Converte o JSON do caso em `ObraIdentityInput`.
fn parse_input(v: &Value) -> ObraIdentityInput {
    let opt_str = |key: &str| -> Option<String> {
        v.get(key)
            .and_then(|val| val.as_str())
            .map(|s| s.to_string())
    };
    let opt_f64 = |key: &str| -> Option<f64> {
        v.get(key)
            .and_then(|val| if val.is_null() { None } else { val.as_f64() })
    };
    ObraIdentityInput {
        adapter_id: opt_str("adapterId").unwrap_or_default(),
        account: opt_str("account").unwrap_or_default(),
        type_: opt_str("type"),
        imdb_id: opt_str("imdbId"),
        season: opt_f64("season"),
        episode: opt_f64("episode"),
        is_pack: v
            .get("isPack")
            .and_then(|val| val.as_bool())
            .unwrap_or(false),
        search_key: opt_str("searchKey"),
    }
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let identity_input = parse_input(&c);
    match c["op"].as_str().expect("campo op") {
        "obraIdentity" => obra_identity(&identity_input),
        "obraKey" => {
            let id = obra_identity(&identity_input);
            obra_key(&id)
        }
        "obraDigest" => {
            let id = obra_identity(&identity_input);
            obra_digest(&id)
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
    assert_eq!(m.output.path, "rust/golden/autofetch-obra.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-autofetch-obra.json");
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
    assert_eq!(cases.len(), 25, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
