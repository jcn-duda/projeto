//! Golden de `src/utils/crawl-store-rules.ts` → `adom-core::crawl_store_rules`.
//!
//! Cobre as regras puras + codec (`backoff`, `parseProgress`, `renderProgress`,
//! `progressAdvanced`, `withDryFlag`, `decideUpsert`, `applyResult`, `renderUrl`,
//! `parseStatus`, `parseUrlRow`, `emptyCounters`). O `expected` veio do `dist`
//! vivo pelo oráculo `scripts/golden/crawl-store-rules-oracle.mjs`; a saída é
//! SEMPRE string, com codificação fixa por `op`.
//!
//! Exercita a API exportada pelo crate. O helper privado `js_text` entra por
//! `#[path]` somente para renderizar os valores do driver como o oráculo JS.

mod common;

#[allow(dead_code)]
#[path = "../src/js_text.rs"]
mod js_text;

use std::collections::HashSet;

use adom_core::{
    apply_result, decide_upsert, empty_counters, error_backoff_ms, parse_progress, parse_status,
    parse_url_row, progress_advanced, render_progress, render_url, with_dry_flag, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/crawl-store-rules.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/crawl-store-rules.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-crawl-store-rules.json");

const REGISTRY_MATCH: &str = "crawl-store-rules/crawlStoreRules";

/// `String(n)` do JS para o único `op` escalar (`backoff`). `NaN`/`Infinity`
/// viram texto, não `null` (o `JSON.stringify` é que faz isso, não o `String`).
fn number_text(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n < 0.0 { "-Infinity" } else { "Infinity" }.to_string();
    }
    let v = Value::Number(serde_json::Number::from_f64(n).expect("finito"));
    js_text::js_to_string(&v)
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        // `value` ausente já vem como `null` do índice, e `raw ?? ''` o absorve.
        "backoff" => number_text(error_backoff_ms(&c["baseMs"], &c["tries"])),
        "parseProgress" => match parse_progress(&c["raw"]) {
            Some(v) => js_text::js_stringify(&v),
            None => "null".to_string(),
        },
        "renderProgress" => render_progress(&c["p"]),
        "progressAdvanced" => {
            if progress_advanced(&c["prev"], &c["next"]) {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        "withDryFlag" => with_dry_flag(&c["raw"]),
        "decideUpsert" => js_text::js_stringify(&decide_upsert(
            &c["site"],
            &c["existing"],
            &c["entry"],
            &c["now"],
        )),
        "applyResult" => js_text::js_stringify(&apply_result(
            &c["existing"],
            &c["result"],
            &c["now"],
            &c["opts"],
        )),
        "renderUrl" => js_text::js_stringify(&render_url(&c["row"])),
        "parseStatus" => parse_status(&c["value"]),
        "parseUrlRow" => js_text::js_stringify(&parse_url_row(&c["r"])),
        "emptyCounters" => js_text::js_stringify(&empty_counters()),
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
    assert_eq!(m.output.path, "rust/golden/crawl-store-rules.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-crawl-store-rules.json"
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
    // Catraca de contagem: 18 de backoff + progresso + upsert + applyResult +
    // codec. Uma regeneração que encolha o corpus junto com o manifest não passa.
    assert_eq!(cases.len(), 169, "contagem de casos do corpus mudou");
    for case in cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
