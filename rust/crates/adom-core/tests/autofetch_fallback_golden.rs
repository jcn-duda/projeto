//! Golden de `src/providers/autofetch-fallback.ts` →
//! `adom-core::autofetch_fallback`.
//!
//! Cobre `compose_queue_entries` e `to_queue_candidate`. O `expected` veio do
//! oráculo `scripts/golden/autofetch-fallback-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{
    compose_queue_entries, to_queue_candidate, FallbackPick, FallbackPool, PoolStream,
    QueueCandidateOpts, QueueEntry, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-fallback.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-fallback.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-autofetch-fallback.json");

const REGISTRY_MATCH: &str = "autofetch-fallback/composeQueueEntries";

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|val| if val.is_null() { None } else { val.as_str() })
        .map(|s| s.to_string())
}

fn opt_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key)
        .and_then(|val| if val.is_null() { None } else { val.as_i64() })
}

fn render_compose(v: &Value) -> String {
    let primary: Vec<QueueEntry> = v["primary"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .enumerate()
        .map(|(i, e)| QueueEntry {
            index: i,
            pool: e["pool"].as_str().unwrap_or("br").to_string(),
            rare: false,
            slot_limit: None,
        })
        .collect();
    let fallbacks: Vec<FallbackPick> = v["fallbacks"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .enumerate()
        .map(|(i, e)| FallbackPick {
            index: primary.len() + i,
            pool: match e["pool"].as_str().unwrap_or("seeds") {
                "any" => FallbackPool::Any,
                _ => FallbackPool::Seeds,
            },
            rare: false,
            slot_limit: None,
        })
        .collect();
    let depth = v["depth"].as_i64().unwrap_or(0);
    let result = compose_queue_entries(&primary, &fallbacks, depth);

    // Reconstrói os hashes na ordem do resultado.
    let all_hashes: Vec<String> = v["primary"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .chain(v["fallbacks"].as_array().unwrap_or(&vec![]).iter())
        .map(|e| e["infoHash"].as_str().unwrap_or("").to_lowercase())
        .collect();
    let out: Vec<Value> = result
        .iter()
        .map(|entry| {
            serde_json::json!({
                "infoHash": all_hashes.get(entry.index).cloned().unwrap_or_default(),
                "pool": entry.pool,
            })
        })
        .collect();
    serde_json::to_string(&out).unwrap_or_default()
}

fn render_to_queue_candidate(v: &Value) -> String {
    let s = &v["stream"];
    let stream = PoolStream {
        info_hash: opt_str(s, "infoHash"),
        name: opt_str(s, "name"),
        title: opt_str(s, "title"),
        quality: opt_str(s, "_quality"),
        seeders: opt_i64(s, "_seeders"),
        is_br: s.get("_br").and_then(|b| b.as_bool()).unwrap_or(false),
        is_dubbed: s.get("_dubbed").and_then(|b| b.as_bool()).unwrap_or(false),
        is_dub_claim: false,
        is_bank_dub: s.get("_bankDub").and_then(|b| b.as_bool()).unwrap_or(false),
        is_lied: s.get("_lied").and_then(|b| b.as_bool()).unwrap_or(false),
        from_fallback: false,
        fallback_fetchable: false,
    };
    let pool = v["pool"].as_str().unwrap_or("seeds");
    let o = &v["opts"];
    let size_bytes = s.get("_size").and_then(|val| val.as_f64());
    let opts = QueueCandidateOpts {
        imdb_id: opt_str(o, "imdbId"),
        season: opt_i64(o, "season"),
        episode: opt_i64(o, "episode"),
        season_fill: o
            .get("seasonFill")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        rare: o.get("rare").and_then(|b| b.as_bool()).unwrap_or(false),
        slot_limit: opt_i64(o, "slotLimit"),
        size_bytes,
    };
    let r = to_queue_candidate(&stream, pool, &opts);
    serde_json::json!({
        "infoHash": r.info_hash,
        "pool": r.pool,
        "quality": r.quality,
        "seeders": r.seeders,
        "br": r.br,
        "dubbed": r.dubbed,
        "bankDub": r.bank_dub,
        "lied": r.lied,
        "season": r.season,
        "episode": r.episode,
        "isPack": r.is_pack,
        "rare": r.rare,
        "slotLimit": r.slot_limit,
    })
    .to_string()
}

fn render(input: &str) -> String {
    let v: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match v["op"].as_str().expect("campo op") {
        "composeQueueEntries" => render_compose(&v),
        "toQueueCandidate" => render_to_queue_candidate(&v),
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
    assert_eq!(m.output.path, "rust/golden/autofetch-fallback.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-autofetch-fallback.json"
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
    assert_eq!(cases.len(), 12, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        let esperado: Value = serde_json::from_str(&case.expected).expect("expected é JSON válido");
        let obtido_v: Value = serde_json::from_str(&obtido).expect("render é JSON válido");
        assert_eq!(
            obtido_v, esperado,
            "caso {} divergiu:\n  obtido:   {}\n  esperado: {}",
            case.id, obtido, case.expected
        );
    }
}
