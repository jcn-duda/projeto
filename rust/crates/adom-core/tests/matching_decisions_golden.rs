//! Integridade e paridade do golden das decisões de `matching-tokens`.
//!
//! Cada entrada é um JSON com `op` e os argumentos; a saída é um valor só:
//! número (precisão, formatado como o JS), `1`/`0` ou o token (`-` para
//! undefined). A comparação é exata. Ano `null` chega como `""`, o mesmo que o
//! JS faz com `String(x || '')`.

use std::collections::HashSet;

use adom_core::{
    adaptation_identity_contradicts, first_significant_token, live_action_year_contradicts,
    named_sequel_contradicts, title_precision, year_contradicts, MANIFEST_FORMAT,
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/matching-tokens-decisions.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/matching-tokens-decisions.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-matching-tokens-decisions.json");

const REGISTRY_MATCH: &str = "matching-tokens/decisions";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    registry: Vec<String>,
    corpus: CorpusRef,
    output: OutputRef,
}

#[derive(Debug, Deserialize)]
struct CorpusRef {
    path: String,
    sha256: String,
    cases: usize,
}

#[derive(Debug, Deserialize)]
struct OutputRef {
    path: String,
    sha256: String,
    lines: usize,
}

#[derive(Debug, Deserialize)]
struct GoldenCase {
    id: String,
    input: String,
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

fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST_TEXT).expect("manifest golden precisa ser JSON válido")
}

fn jsonl_lines() -> Vec<&'static str> {
    let text = std::str::from_utf8(JSONL_BYTES).expect("golden precisa ser UTF-8");
    text.trim_end_matches('\n').split('\n').collect()
}

fn parse_all_cases() -> Vec<GoldenCase> {
    jsonl_lines()
        .iter()
        .map(|line| {
            serde_json::from_str(line).expect("linha do golden commitado precisa ser válida")
        })
        .collect()
}

/// Valor JSON como o JS o converte com `String(x || '')`: `null` vira vazio.
fn as_year_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .expect("lista de strings")
        .iter()
        .map(|x| x.as_str().expect("string").to_string())
        .collect()
}

fn bit(v: bool) -> String {
    if v { "1" } else { "0" }.to_string()
}

/// Despacha uma entrada do corpus para a função Rust correspondente.
fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "precision" => {
            let cut_tail = c.get("cutTail").and_then(Value::as_bool).unwrap_or(true);
            // Mesmo formato do `String(number)` do JS: 1 vira "1", 0.5 vira "0.5".
            title_precision(&strings(&c["tokens"]), &strings(&c["wanted"]), cut_tail).to_string()
        }
        "year" => bit(year_contradicts(
            &strings(&c["tokens"]),
            &as_year_text(&c["year"]),
            c["series"].as_bool().unwrap_or(false),
        )),
        "sequel" => bit(named_sequel_contradicts(
            &strings(&c["tokens"]),
            &strings(&c["universe"]),
            &as_year_text(&c["catalogYear"]),
        )),
        "liveAction" => bit(live_action_year_contradicts(
            c["text"].as_str().expect("texto"),
            &as_year_text(&c["premiereYear"]),
        )),
        "adaptation" => {
            // `request?.season == null`: ausente ou null não conta como série.
            let season_present = c["request"].get("season").is_some_and(|s| !s.is_null());
            bit(adaptation_identity_contradicts(
                season_present,
                c["text"].as_str().expect("texto"),
                &as_year_text(&c["year"]),
            ))
        }
        "first" => first_significant_token(&strings(&c["tokens"]))
            .unwrap_or("-")
            .to_string(),
        other => panic!("op desconhecida no golden: {other}"),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest();
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(jsonl_lines().len(), m.output.lines);
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/matching-tokens-decisions.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-matching-tokens-decisions.json"
    );
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest();
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn ids_unicos_e_corpus_concorda_com_o_golden() {
    let cases = parse_all_cases();
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    let corpus: Value = serde_json::from_str(CORPUS_TEXT).expect("corpus JSON válido");
    let raw = corpus["cases"].as_array().expect("cases: array");
    assert_eq!(raw.len(), cases.len());
    for (case, row) in cases.iter().zip(raw) {
        assert_eq!(row["id"].as_str(), Some(case.id.as_str()));
        assert_eq!(row["input"].as_str(), Some(case.input.as_str()));
    }
}

#[test]
fn decisoes_batem_com_o_golden_caso_a_caso() {
    for case in parse_all_cases() {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu do golden\nentrada: {}",
            case.id, case.input
        );
    }
}
