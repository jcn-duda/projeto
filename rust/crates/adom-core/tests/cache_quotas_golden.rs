//! Golden de `src/utils/cache-quotas.ts` → `adom-core::cache_quotas`.
//!
//! Casos com `op` entre `quotas`, `max`, `quota`, `namespace`, `universe` e
//! `validate`. O `expected` veio do `dist` vivo (oráculo
//! `scripts/golden/registry-cache-quotas.mjs`).
//!
//! `universe`/`validate` não são funções exportadas do fonte: são a conta que
//! `test/cache-namespaces.test.ts` faz sobre a UNIÃO de `QUOTAS` com
//! `NAMESPACE_VERSIONS`. Ela está aqui porque foi exatamente essa conta que
//! estourou o teto em produção (1.051 entradas despejadas com todos os
//! namespaces dentro da própria cota).
//!
//! `incrementNamespace`/`removeFromStore`/`quotaOverflow` do fonte não têm caso:
//! recebem o `store` LRU do motor de cache, que ainda não foi portado.
//!
//! Os módulos entram por `#[path]` porque ainda não estão registrados em
//! `lib.rs` — o caminho (`crate::cache_keys`, `crate::cache_quotas`) é o mesmo
//! que terão quando forem declarados na raiz do crate.

#![allow(dead_code)]

mod common;

#[path = "../src/cache_keys.rs"]
mod cache_keys;
#[path = "../src/cache_quotas.rs"]
mod cache_quotas;

use std::collections::HashSet;

use adom_core::MANIFEST_FORMAT;
use serde_json::Value;

use common::{assert_corpus_matches, jsonl_lines, manifest, parse_cases, sha256_hex};

use cache_quotas::{
    namespace_for, namespaces_without_explicit_quota, quota_for, universe, universe_total,
    validate_quotas, MAX_ENTRIES, QUOTAS,
};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/cache-quotas.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/cache-quotas.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-cache-quotas.json");

const REGISTRY_MATCH: &str = "cache-quotas/policy";

/// `JSON.stringify(Object.entries(QUOTAS))` — na ordem de inserção do objeto TS.
fn render_quotas() -> String {
    let pares: Vec<String> = QUOTAS
        .iter()
        .map(|(ns, cota)| {
            assert!(ns.is_ascii(), "nome precisa ser ASCII para o JSON literal");
            format!("[\"{ns}\",{cota}]")
        })
        .collect();
    format!("[{}]", pares.join(","))
}

/// Objeto fixo do universo, na MESMA ordem de chaves do oráculo:
/// `names, soma, max, folga, semCota, quotas`.
fn render_universe() -> String {
    let nomes = universe();
    let soma = universe_total();
    let sem_cota: Vec<String> = namespaces_without_explicit_quota()
        .iter()
        .map(|ns| format!("\"{ns}\""))
        .collect();
    let pares: Vec<String> = nomes
        .iter()
        .map(|ns| format!("[\"{ns}\",{}]", quota_for(ns)))
        .collect();
    format!(
        "{{\"names\":{},\"soma\":{},\"max\":{},\"folga\":{},\"semCota\":[{}],\"quotas\":[{}]}}",
        nomes.len(),
        soma,
        MAX_ENTRIES,
        MAX_ENTRIES as i64 - soma as i64,
        sem_cota.join(","),
        pares.join(",")
    )
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("op presente") {
        "quotas" => render_quotas(),
        "max" => MAX_ENTRIES.to_string(),
        "quota" => quota_for(c["ns"].as_str().expect("ns: string")).to_string(),
        "namespace" => namespace_for(c["key"].as_str().expect("key: string")).to_string(),
        "universe" => render_universe(),
        "validate" => validate_quotas().to_string(),
        outra => panic!("op desconhecida: {outra}"),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/cache-quotas.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-cache-quotas.json");
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
    assert!(cases.len() >= 100, "golden precisa de pelo menos 100 casos");
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

#[test]
fn toda_cota_declarada_e_todo_namespace_versionado_tem_caso() {
    let casos = parse_cases(JSONL_BYTES);
    for (ns, _) in QUOTAS {
        assert!(
            casos
                .iter()
                .any(|c| c.input == format!("{{\"op\":\"quota\",\"ns\":\"{ns}\"}}")),
            "sem caso de cota para {ns}"
        );
    }
    for (ns, _) in cache_keys::NAMESPACE_VERSIONS {
        assert!(
            casos
                .iter()
                .any(|c| c.input == format!("{{\"op\":\"quota\",\"ns\":\"{ns}\"}}")),
            "namespace versionado sem caso de cota: {ns}"
        );
        assert!(
            casos
                .iter()
                .any(|c| c.input
                    == format!("{{\"op\":\"namespace\",\"key\":\"{ns}:qualquer:coisa\"}}")),
            "namespace versionado sem caso de leitura de chave: {ns}"
        );
    }
}
