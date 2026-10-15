//! Golden de `src/providers/autofetch-gates.ts` → `adom-core::autofetch_gates`.
//!
//! Cobre `classifyEnqueue` (os 9 portões, ordem exata) e a tabela de rollback
//! (`ENQUEUE_ROLLBACK`). O `expected` veio do dist vivo pelo oráculo
//! `scripts/golden/autofetch-gates-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{
    classify_enqueue, rollback_for, skip_reason_label, EnqueueGates, SkipReason, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-gates.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-gates.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-autofetch-gates.json");

const REGISTRY_MATCH: &str = "autofetch-gates/classifyEnqueue";

// ─── Helpers de desserialização ─────────────────────────────────────────────

/// Booleano com default — espelha o `flag(g, key, def)` do oráculo.
fn gate_bool(g: &Value, key: &str, default: bool) -> bool {
    match g.get(key).and_then(Value::as_bool) {
        Some(v) => v,
        None => default,
    }
}

/// Monta `EnqueueGates` a partir do objeto `gates` do caso, com o caminho feliz
/// como default (positivos = false, `try*` = true) — paridade com o oráculo.
fn parse_gates(g: &Value) -> EnqueueGates {
    EnqueueGates {
        is_paused: gate_bool(g, "isPaused", false),
        is_dead: gate_bool(g, "isDead", false),
        is_cached: gate_bool(g, "isCached", false),
        marker_active: gate_bool(g, "markerActive", false),
        lock_acquired: gate_bool(g, "tryLock", true),
        slot_acquired: gate_bool(g, "trySlot", true),
        obra_cap_granted: gate_bool(g, "tryObraCap", true),
        account_blocked: gate_bool(g, "accountBlocked", false),
        budget_granted: gate_bool(g, "tryBudget", true),
    }
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "classifyEnqueue" => {
            let gates = parse_gates(&c["gates"]);
            match classify_enqueue(&gates) {
                Some(reason) => skip_reason_label(reason).to_string(),
                None => "null".to_string(),
            }
        }
        "rollbackFor" => {
            let reason = SkipReason::parse(c["reason"].as_str().unwrap_or(""))
                .expect("reason do corpus é um portão válido");
            let actions: Vec<&str> = rollback_for(reason).iter().map(|a| a.as_str()).collect();
            serde_json::to_string(&actions).expect("json")
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
    assert_eq!(m.output.path, "rust/golden/autofetch-gates.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-autofetch-gates.json");
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
    assert_eq!(cases.len(), 30, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
