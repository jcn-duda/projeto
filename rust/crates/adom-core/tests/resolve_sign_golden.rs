//! Consumo e integridade do golden de `signResolve` / `verifyResolve`.
//!
//! Segue o padrão de `tests/golden_corpus.rs`: `include_bytes!`/`include_str!`
//! em tempo de compilação, sha256 do JSONL e do corpus conferidos com o
//! manifest, contagem = 24 casos, paridade caso a caso com `sign_resolve` e
//! `verify_resolve` do módulo `resolve_sign`.
//!
//! O `sig` no JSONL pode ser string, null ou número — modelamos como
//! `Option<serde_json::Value>` e convertemos para `Option<&str>` na hora de
//! chamar `verify_resolve` (null/número → `None`, espelhando o `typeof` do TS).

use std::collections::HashSet;

use adom_core::MANIFEST_FORMAT;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/resolve-sign.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/resolve-sign.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-resolve-sign.json");

const EXPECTED_LINES: usize = 24;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    registry: Vec<String>,
    functions: Vec<FunctionEntry>,
    corpus: CorpusRef,
    output: OutputRef,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FunctionEntry {
    #[allow(dead_code)]
    id: String,
    name: String,
    source_path: String,
    source_sha256: String,
    artifact_path: String,
    artifact_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusRef {
    path: String,
    sha256: String,
    cases: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputRef {
    path: String,
    sha256: String,
    lines: usize,
}

/// Caso do golden — `sig` pode ser string, null ou número no JSON original.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignCase {
    id: String,
    key: String,
    #[allow(dead_code)]
    key_source: String,
    info_hash: String,
    ep: String,
    hint: String,
    sig: Option<serde_json::Value>,
    expected: String,
    verified: bool,
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

fn parse_case(line: &str) -> Result<SignCase, String> {
    serde_json::from_str(line).map_err(|e| format!("linha JSONL inválida: {e}"))
}

fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST_TEXT).expect("manifest golden precisa ser JSON válido")
}

fn jsonl_lines() -> Vec<&'static str> {
    let text = std::str::from_utf8(JSONL_BYTES).expect("golden precisa ser UTF-8");
    text.trim_end_matches('\n').split('\n').collect()
}

fn parse_all_cases() -> Vec<SignCase> {
    jsonl_lines()
        .iter()
        .map(|line| parse_case(line).expect("linha do golden commitado precisa ser válida"))
        .collect()
}

/// Converte o `sig` do JSONL (string | null | número) em `Option<&str>` para
/// o `verify_resolve`. Null e não-string viram `None` (espelha `typeof` do TS).
fn sig_as_str(sig: &Option<serde_json::Value>) -> Option<&str> {
    sig.as_ref().and_then(|v| v.as_str())
}

// ─────────────────────────────────────────────────────────────────────────────
// Testes de integridade do corpus (espelham golden_corpus.rs).
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn manifest_tem_formato_registro_e_funcoes_esperados() {
    let m = manifest();
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(
        m.registry,
        vec![
            "resolve-sign/signResolve".to_string(),
            "resolve-sign/verifyResolve".to_string(),
        ]
    );
    assert_eq!(m.functions.len(), 2);
    assert_eq!(m.functions[0].name, "signResolve");
    assert_eq!(m.functions[1].name, "verifyResolve");
    for f in &m.functions {
        assert_eq!(f.source_path, "src/utils/sign.ts");
        assert_eq!(f.artifact_path, "dist/src/utils/sign.js");
        assert_eq!(f.source_sha256.len(), 64);
        assert_eq!(f.artifact_sha256.len(), 64);
    }
}

#[test]
fn corpus_jsonl_nao_vazio_e_contagem_24_bate_com_manifest() {
    let m = manifest();
    let (o, c) = (&m.output, &m.corpus);
    let lines = jsonl_lines();
    assert!(!lines.is_empty(), "golden não pode ser vazio");
    assert_eq!(lines.len(), EXPECTED_LINES, "contagem de linhas do JSONL");
    assert_eq!(o.lines, EXPECTED_LINES, "manifest.output.lines");
    assert_eq!(c.cases, EXPECTED_LINES, "manifest.corpus.cases");
    assert_eq!(o.path, "rust/golden/resolve-sign.jsonl");
    assert_eq!(c.path, "scripts/golden/corpus-resolve-sign.json");
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest();
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn casos_tem_ids_unicos_e_campos_presentes() {
    let cases = parse_all_cases();
    assert_eq!(cases.len(), EXPECTED_LINES);
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(!case.id.is_empty(), "id vazio");
        assert!(ids.insert(case.id.clone()), "id duplicado: {}", case.id);
    }
}

#[test]
fn corpus_fonte_e_jsonl_concordam_em_ids_e_ordem() {
    let cases = parse_all_cases();
    let corpus: serde_json::Value =
        serde_json::from_str(CORPUS_TEXT).expect("corpus JSON válido");
    let raw = corpus["cases"].as_array().expect("cases: array");
    assert_eq!(raw.len(), cases.len(), "contagem diverge");
    for (case, row) in cases.iter().zip(raw) {
        assert_eq!(row["id"].as_str(), Some(case.id.as_str()));
        assert_eq!(row["infoHash"].as_str(), Some(case.info_hash.as_str()));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Paridade comportamental: sign_resolve e verify_resolve caso a caso.
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn sign_resolve_bate_com_todos_os_goldens() {
    let cases = parse_all_cases();
    assert_eq!(cases.len(), EXPECTED_LINES);
    for case in &cases {
        let obtido = adom_core::sign_resolve(&case.info_hash, &case.ep, &case.hint, &case.key);
        assert_eq!(
            obtido, case.expected,
            "sign_resolve caso {} divergiu do golden\n  infoHash: {:?}\n  ep:       {:?}\n  hint:     {:?}\n  key:      {:?}\n  esperado: {:?}\n  obtido:   {:?}",
            case.id, case.info_hash, case.ep, case.hint, case.key, case.expected, obtido
        );
    }
}

#[test]
fn verify_resolve_bate_com_todos_os_goldens() {
    let cases = parse_all_cases();
    assert_eq!(cases.len(), EXPECTED_LINES);
    for case in &cases {
        let sig_str = sig_as_str(&case.sig);
        let obtido = adom_core::verify_resolve(
            &case.info_hash,
            &case.ep,
            sig_str,
            &case.hint,
            &case.key,
        );
        assert_eq!(
            obtido, case.verified,
            "verify_resolve caso {} divergiu do golden\n  infoHash: {:?}\n  ep:       {:?}\n  hint:     {:?}\n  sig:      {:?}\n  key:      {:?}\n  esperado: {}\n  obtido:   {}",
            case.id, case.info_hash, case.ep, case.hint, case.sig, case.key, case.verified, obtido
        );
    }
}

/// Casos negativos críticos do golden (sig inválida, uppercase, tamanho errado,
/// null, número, chave errada) DEVEM retornar `verified = false`.
#[test]
fn negativos_criticos_sao_rejeitados() {
    let cases = parse_all_cases();
    let negativos = ["rs-016", "rs-017", "rs-018", "rs-019", "rs-020", "rs-021", "rs-023", "rs-024"];
    for id in &negativos {
        let case = cases
            .iter()
            .find(|c| c.id == *id)
            .unwrap_or_else(|| panic!("caso negativo ausente: {id}"));
        assert!(
            !case.verified,
            "caso {id} deveria ter verified=false no golden"
        );
        let sig_str = sig_as_str(&case.sig);
        let obtido = adom_core::verify_resolve(
            &case.info_hash,
            &case.ep,
            sig_str,
            &case.hint,
            &case.key,
        );
        assert!(!obtido, "negativo {id} foi aceito indevidamente");
    }
}
