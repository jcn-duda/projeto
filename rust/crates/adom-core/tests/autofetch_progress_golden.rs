//! Golden de `src/providers/autofetch-progress.ts` → `adom-core::autofetch_progress`.
//!
//! Cobre a derivação conservadora de parada por progresso com memória INJETADA
//! (`ProgressMemory`), a limpeza por hash/lote e o ciclo de vida da memória.
//! O `expected` veio do dist vivo pelo oráculo
//! `scripts/golden/autofetch-progress-oracle.mjs`.

mod common;

use std::collections::{HashMap, HashSet};

use adom_core::{
    derive_stall, forget_lot_progress, forget_progress, progress_memory_size, ProgressLot,
    ProgressMemory, TorrentProgress, TorrentStatus, MANIFEST_FORMAT,
};
use serde_json::{json, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-progress.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-progress.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-autofetch-progress.json");

const REGISTRY_MATCH: &str = "autofetch-progress/autofetchProgress";

// ─── Helpers de desserialização ─────────────────────────────────────────────

/// Campo numérico do progresso; ausente/não numérico vira `NAN` (paridade com
/// `Number(undefined)` do TS, que o guarda `is_finite` descarta).
fn num_field(p: &Value, key: &str) -> f64 {
    p.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// `status.id != null ? String(status.id) : ''` do TS → `None` quando nulo.
fn json_id(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(match n.as_i64() {
            Some(i) => i.to_string(),
            None => n.to_string(),
        }),
        other => Some(other.to_string()),
    }
}

fn parse_status(v: &Value) -> TorrentStatus {
    TorrentStatus {
        state: v
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        id: v.get("id").and_then(json_id),
        progress: v.get("progress").map(|p| TorrentProgress {
            bytes: num_field(p, "bytes"),
            total: num_field(p, "total"),
            speed: num_field(p, "speed"),
            seeders: num_field(p, "seeders"),
        }),
    }
}

fn parse_statuses(v: &Value) -> HashMap<String, TorrentStatus> {
    let mut map = HashMap::new();
    if let Some(obj) = v.as_object() {
        for (k, s) in obj {
            map.insert(k.clone(), parse_status(s));
        }
    }
    map
}

fn string_list(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let adapter_id = c["adapterId"].as_str().unwrap_or("");
    let account = c["account"].as_str().unwrap_or("");
    let threshold = c["threshold"].as_i64().unwrap_or(0);
    let hashes = string_list(&c["hashes"]);
    let mut memory = ProgressMemory::new();
    let base = progress_memory_size(&memory) as i64;
    let lot = ProgressLot {
        adapter_id,
        account,
        hashes: &hashes,
        threshold,
    };
    match c["op"].as_str().expect("campo op") {
        "sequence" => {
            let mut results: Vec<Value> = Vec::new();
            for pass in c["passes"].as_array().expect("passes: array") {
                let statuses = parse_statuses(pass);
                let d = derive_stall(&mut memory, &lot, &statuses);
                let mut stalled: Vec<String> = d.stalled.into_iter().collect();
                stalled.sort();
                results.push(json!({ "stalled": stalled, "signals": d.signals }));
            }
            let created = progress_memory_size(&memory) as i64 - base;
            forget_lot_progress(&mut memory, adapter_id, account, &hashes);
            let after_forget = progress_memory_size(&memory) as i64 - base;
            serde_json::to_string(&json!({
                "results": results,
                "created": created,
                "afterForget": after_forget,
            }))
            .expect("json")
        }
        "forgetOne" => {
            let statuses = parse_statuses(&c["pass"]);
            derive_stall(&mut memory, &lot, &statuses);
            let created_after_derive = progress_memory_size(&memory) as i64 - base;
            let forget_hash = c["forgetHash"].as_str().unwrap_or("");
            forget_progress(&mut memory, adapter_id, account, forget_hash);
            let after_forget_one = progress_memory_size(&memory) as i64 - base;
            forget_lot_progress(&mut memory, adapter_id, account, &hashes);
            let fim = progress_memory_size(&memory) as i64 - base;
            serde_json::to_string(&json!({
                "createdAfterDerive": created_after_derive,
                "afterForgetOne": after_forget_one,
                "final": fim,
            }))
            .expect("json")
        }
        other => panic!("op desconhecida no golden: {other}"),
    }
}

// ─── Testes ─────────────────────────────────────────────────────────────────

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/autofetch-progress.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-autofetch-progress.json"
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
    assert_eq!(cases.len(), 16, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
