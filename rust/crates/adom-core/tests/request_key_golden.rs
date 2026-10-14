//! Golden de `src/utils/request-key.ts` → módulo `request_key`.
//!
//! Cada linha do JSONL é um caso com `op` entre `account`, `scope` e `key`. O
//! `expected` veio do `dist` vivo (oráculo `scripts/golden/request-key-oracle.mjs`)
//! e é comparado BYTE A BYTE: a saída é sempre string e a ORDEM das chaves do
//! `JSON.stringify` faz parte do contrato.
//!
//! Usa a API exportada pelo crate, para verificar também o registro real e
//! evitar executar novamente os testes unitários dos módulos via `#[path]`.

mod common;

use std::collections::HashSet;

use serde_json::Value;

use adom_core::{account_scope, streams_cache_key, streams_cache_scope};
use common::{assert_corpus_matches, jsonl_lines, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/request-key.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/request-key.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-request-key.json");

const REGISTRY_MATCH: &str = "request-key/streamsCacheKey";

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("op presente") {
        // `apiKey` ausente indexa para `Null` — falsy, como `undefined` no TS.
        "account" => account_scope(&c["apiKey"]),
        // `options` ausente é o default `{}` do TS.
        "scope" => streams_cache_scope(&c["options"]),
        "key" => streams_cache_key(
            c["type"].as_str().expect("type: string"),
            c["id"].as_str().expect("id: string"),
            &c["options"],
        ),
        outra => panic!("op desconhecida no golden: {outra}"),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, adom_core::MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/request-key.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-request-key.json");
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
    // Catraca de contagem: uma regeneração que encolha o corpus junto com o
    // manifest não passa aqui.
    assert_eq!(cases.len(), 65, "contagem de casos do corpus mudou");
    for case in cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
