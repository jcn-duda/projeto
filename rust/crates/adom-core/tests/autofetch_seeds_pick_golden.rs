//! Golden de `src/providers/autofetch-seeds-pool.ts` →
//! `adom-core::autofetch_seeds_pick`.
//!
//! Cobre `pick_seeds_pool` — seleção do pool seeds com raro, complemento
//! relaxado e viabilidade. O `expected` veio do oráculo
//! `scripts/golden/autofetch-seeds-pick-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{
    pick_seeds_pool, PoolStream, RareConfig, SeedsPickLive, SeedsPickOpts, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-seeds-pick.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-seeds-pick.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-autofetch-seeds-pick.json");

const REGISTRY_MATCH: &str = "autofetch-seeds-pick/pickSeedsPool";

fn opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|val| if val.is_null() { None } else { val.as_str() })
        .map(|s| s.to_string())
}

fn opt_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key)
        .and_then(|val| if val.is_null() { None } else { val.as_i64() })
}

fn parse_stream(v: &Value) -> PoolStream {
    PoolStream {
        info_hash: opt_str(v, "infoHash"),
        name: opt_str(v, "name"),
        title: opt_str(v, "title"),
        quality: opt_str(v, "_quality"),
        seeders: opt_i64(v, "_seeders"),
        is_br: v.get("_br").and_then(|b| b.as_bool()).unwrap_or(false),
        is_dubbed: v.get("_dubbed").and_then(|b| b.as_bool()).unwrap_or(false),
        is_dub_claim: v
            .get("_dubClaim")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        is_bank_dub: v.get("_bankDub").and_then(|b| b.as_bool()).unwrap_or(false),
        is_lied: v.get("_lied").and_then(|b| b.as_bool()).unwrap_or(false),
        from_fallback: false,
        fallback_fetchable: false,
    }
}

fn render(input: &str) -> String {
    let v: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let streams: Vec<PoolStream> = v["streams"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(parse_stream)
        .collect();
    let live_v = &v["live"];
    let live = SeedsPickLive {
        min_seeders: live_v["minSeeders"].as_i64().unwrap_or(1),
        top_seeds_max: live_v["topSeedsMax"].as_i64().unwrap_or(2),
        pt_first: live_v["ptFirst"].as_bool().unwrap_or(false),
    };
    let opts_v = &v["opts"];
    let rare_v = &opts_v["rare"];
    let opts = SeedsPickOpts {
        season: opt_i64(opts_v, "season"),
        queue_depth: opts_v["queueDepth"].as_i64().unwrap_or(0),
        rare: RareConfig {
            max: rare_v["max"].as_i64().unwrap_or(0),
            threshold: rare_v["threshold"].as_i64().unwrap_or(0),
            max_seeders: rare_v["maxSeeders"].as_i64().unwrap_or(0),
        },
    };
    let viable: HashSet<String> = v["viable"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|val| val.as_str())
        .map(|s| s.to_lowercase())
        .collect();

    let result = pick_seeds_pool(&streams, &live, &opts, &viable);
    let candidates: Vec<String> = result
        .candidates
        .iter()
        .map(|&i| streams[i].info_hash.as_deref().unwrap_or("").to_lowercase())
        .collect();
    serde_json::json!({
        "candidates": candidates,
        "immediateLimit": result.immediate_limit,
        "rareUsed": result.rare_used,
    })
    .to_string()
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/autofetch-seeds-pick.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-autofetch-seeds-pick.json"
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
    assert_eq!(cases.len(), 20, "contagem de casos do corpus mudou");
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
