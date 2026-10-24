//! Golden de `src/utils/cache-keys.ts` → `adom-core::cache_keys`.
//!
//! Cada linha do JSONL é um caso com `op` entre `versions`, `legacy`, `magmeta`,
//! `prefix` e `key`. O `expected` veio do `dist` vivo (oráculo
//! `scripts/golden/registry-cache-keys.mjs`), então a paridade é com o
//! comportamento EXECUTADO, não com o comportamento testado.
//!
//! O módulo ainda não está registrado em `lib.rs` (guarda do porte: quem integra
//! decide a API pública). Ele entra aqui por `#[path]`, como módulo do próprio
//! crate de teste — o mesmo caminho (`crate::cache_keys`) que ele terá quando
//! `lib.rs` declará-lo. Não há duplicação de código: é o mesmo arquivo fonte.

#![allow(dead_code)]

mod common;

#[path = "../src/cache_keys.rs"]
mod cache_keys;

use std::collections::HashSet;

use adom_core::MANIFEST_FORMAT;
use serde_json::Value;

use cache_keys::{cache_key, mag_meta_counts_key, prefix, LEGACY_PREFIXES, NAMESPACE_VERSIONS};
use common::{assert_corpus_matches, jsonl_lines, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/cache-keys.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/cache-keys.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-cache-keys.json");

const REGISTRY_MATCH: &str = "cache-keys/namespace-versions";

/// `JSON.stringify(Object.entries(NAMESPACE_VERSIONS))` — a ordem de inserção é
/// parte do contrato, então o `expected` só bate se a tabela for portada na
/// mesma sequência do objeto TS.
fn render_versions() -> String {
    let pares: Vec<String> = NAMESPACE_VERSIONS
        .iter()
        .map(|(ns, versao)| {
            assert!(
                ns.is_ascii() && versao.is_ascii(),
                "nome precisa ser ASCII para o JSON literal"
            );
            format!("[\"{ns}\",\"{versao}\"]")
        })
        .collect();
    format!("[{}]", pares.join(","))
}

/// `JSON.stringify(LEGACY_PREFIXES)`.
fn render_legacy() -> String {
    let itens: Vec<String> = LEGACY_PREFIXES.iter().map(|p| format!("\"{p}\"")).collect();
    format!("[{}]", itens.join(","))
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("op presente") {
        "versions" => render_versions(),
        "legacy" => render_legacy(),
        "magmeta" => mag_meta_counts_key(),
        "prefix" => prefix(c["ns"].as_str().expect("ns: string")).to_string(),
        "key" => {
            let partes: Vec<&str> = c["parts"]
                .as_array()
                .expect("parts: array")
                .iter()
                .map(|p| p.as_str().expect("parte é string"))
                .collect();
            cache_key(c["ns"].as_str().expect("ns: string"), &partes)
        }
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
    assert_eq!(m.output.path, "rust/golden/cache-keys.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-cache-keys.json");
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
    assert!(cases.len() >= 50, "golden precisa de pelo menos 50 casos");
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
fn todo_namespace_versionado_tem_caso_no_golden() {
    // O corpus é derivado do `dist`, então a cobertura é estrutural: se um
    // namespace novo entrar na tabela sem caso regenerado, o golden dele não
    // existe e esta guarda cai antes da comparação byte a byte.
    let casos = parse_cases(JSONL_BYTES);
    for (ns, _) in NAMESPACE_VERSIONS {
        assert!(
            casos
                .iter()
                .any(|c| c.id == format!("ck-prefix-{:02}", prefix_index(ns))),
            "sem caso de prefixo para {ns}"
        );
        assert!(
            casos
                .iter()
                .any(|c| c.input.contains(&format!("\"ns\":\"{ns}\""))),
            "sem caso de chave para {ns}"
        );
    }
}

/// Posição (1-based) do namespace na tabela portada — mesma ordem do objeto TS.
fn prefix_index(namespace: &str) -> usize {
    NAMESPACE_VERSIONS
        .iter()
        .position(|(ns, _)| *ns == namespace)
        .unwrap_or(usize::MAX)
        + 1
}
