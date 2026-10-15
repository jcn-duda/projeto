//! Golden de `src/providers/autofetch-policy.ts` → `adom-core::autofetch_policy`.
//!
//! Cobre as 11 funções puras da política do pool seeds + `stream_title_bytes`.
//! O `expected` veio do dist vivo pelo oráculo `scripts/golden/autofetch-policy-oracle.mjs`.

mod common;

use std::collections::HashSet;

use adom_core::{
    decide_seeds_stop, effective_seeds_max_bytes, filter_seeds_universe, has_playable_stream,
    normalize_seeds_max_quality, seeds_download_bytes, seeds_drain_rejection,
    seeds_intrinsic_rejection, seeds_quality_reject, seeds_selection_block, seeds_size_reject,
    stream_title_bytes, DecideSeedsStopInput, PlayableStream, SeedsCandidate, SeedsPolicyConfig,
    MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-policy.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-policy.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-autofetch-policy.json");

const REGISTRY_MATCH: &str = "autofetch-policy/autofetchPolicy";

// ─── Helpers de desserialização ─────────────────────────────────────────────

fn opt_f64(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

fn opt_string(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(|s| s.to_string())
}

fn parse_candidate(v: &Value) -> SeedsCandidate {
    SeedsCandidate {
        size_field: opt_f64(v, "_size"),
        pack_bytes: opt_f64(v, "_packBytes"),
        quality_underscore: opt_string(v, "_quality"),
        quality_plain: opt_string(v, "quality"),
        size_queue: opt_f64(v, "size"),
        title: opt_string(v, "title"),
        name: opt_string(v, "name"),
    }
}

fn parse_cfg(v: &Value) -> SeedsPolicyConfig {
    SeedsPolicyConfig {
        dubbed_only: v
            .get("dubbedOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        cached_only: v
            .get("cachedOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        max_size_gb: v.get("maxSizeGb").and_then(Value::as_f64).unwrap_or(0.0),
        seeds_max_gb: v.get("seedsMaxGb").and_then(Value::as_f64).unwrap_or(0.0),
        seeds_max_quality: v
            .get("seedsMaxQuality")
            .and_then(Value::as_str)
            .unwrap_or("1080p")
            .to_string(),
    }
}

fn parse_playable(v: &Value) -> PlayableStream {
    PlayableStream {
        notice: v.get("notice").and_then(Value::as_bool).unwrap_or(false),
        url: opt_string(v, "url"),
        info_hash: opt_string(v, "infoHash"),
        external_url: opt_string(v, "externalUrl"),
    }
}

fn parse_playable_list(v: &Value) -> Vec<PlayableStream> {
    v.as_array()
        .map(|a| a.iter().map(parse_playable).collect())
        .unwrap_or_default()
}

fn parse_candidate_list(v: &Value) -> Vec<SeedsCandidate> {
    v.as_array()
        .map(|a| a.iter().map(parse_candidate).collect())
        .unwrap_or_default()
}

/// Formata f64 como inteiro (sem casas decimais) — paridade com `String(n)` do JS.
fn num_str(n: f64) -> String {
    if n == n.trunc() && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn reason_str(r: Option<impl AsRef<str>>) -> String {
    match r {
        Some(v) => v.as_ref().to_string(),
        None => "null".to_string(),
    }
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "normalizeSeedsMaxQuality" => {
            let value = c["value"].as_str().unwrap_or("");
            normalize_seeds_max_quality(value).to_string()
        }
        "effectiveSeedsMaxBytes" => {
            let seeds = c["seedsMaxGb"].as_f64().unwrap_or(0.0);
            let user = c["maxSizeGb"].as_f64().unwrap_or(0.0);
            num_str(effective_seeds_max_bytes(seeds, user))
        }
        "seedsDownloadBytes" => {
            let stream = parse_candidate(&c["stream"]);
            num_str(seeds_download_bytes(&stream))
        }
        "seedsQualityReject" => {
            let stream = parse_candidate(&c["stream"]);
            let max_q = c["maxQuality"].as_str().unwrap_or("1080p");
            reason_str(seeds_quality_reject(&stream, max_q).map(|r| r.as_str()))
        }
        "seedsSizeReject" => {
            let stream = parse_candidate(&c["stream"]);
            let max_bytes = c["maxBytes"].as_f64().unwrap_or(0.0);
            reason_str(seeds_size_reject(&stream, max_bytes).map(|r| r.as_str()))
        }
        "seedsIntrinsicRejection" => {
            let stream = parse_candidate(&c["stream"]);
            let cfg = parse_cfg(&c["cfg"]);
            reason_str(seeds_intrinsic_rejection(&stream, &cfg).map(|r| r.as_str()))
        }
        "filterSeedsUniverse" => {
            let streams = parse_candidate_list(&c["streams"]);
            let cfg = parse_cfg(&c["cfg"]);
            let r = filter_seeds_universe(&streams, &cfg);
            let mut rej = serde_json::Map::new();
            if r.rejected_quality > 0 {
                rej.insert("seeds-quality".into(), r.rejected_quality.into());
            }
            if r.rejected_too_big > 0 {
                rej.insert("seeds-too-big".into(), r.rejected_too_big.into());
            }
            if r.rejected_size_unknown > 0 {
                rej.insert("seeds-size-unknown".into(), r.rejected_size_unknown.into());
            }
            let out = serde_json::json!({"eligible": r.eligible_count, "rejected": rej});
            serde_json::to_string(&out).expect("json")
        }
        "hasPlayableStream" => {
            let streams = parse_playable_list(&c["streams"]);
            if has_playable_stream(&streams) {
                "1".into()
            } else {
                "0".into()
            }
        }
        "seedsSelectionBlock" => {
            let cfg = &c["cfg"];
            let dubbed_only = cfg["dubbedOnly"].as_bool().unwrap_or(false);
            let cached_only = cfg["cachedOnly"].as_bool().unwrap_or(false);
            let streams = parse_playable_list(&c["streams"]);
            let br_probe = c["extra"]["brProbePending"].as_bool().unwrap_or(false);
            reason_str(
                seeds_selection_block(dubbed_only, cached_only, &streams, br_probe)
                    .map(|r| r.as_str()),
            )
        }
        "decideSeedsStop" => {
            let input = DecideSeedsStopInput {
                has_cached_dubbed: c["hasCachedDubbed"].as_bool().unwrap_or(false),
                cached_count: c["cachedCount"].as_i64().unwrap_or(0),
                rare: c["rare"].as_bool().unwrap_or(false),
                rare_threshold: c["rareThreshold"].as_i64().unwrap_or(0),
                adapter_cache_check: c["adapterCacheCheck"].as_bool().unwrap_or(false),
                rare_over_cached: c["rareOverCached"].as_bool().unwrap_or(false),
            };
            let out = decide_seeds_stop(&input);
            let stop = out
                .stop
                .map(|s| Value::String(s.as_str().to_string()))
                .unwrap_or(Value::Null);
            let json = serde_json::json!({"stop": stop, "rareOverCached": out.rare_over_cached});
            serde_json::to_string(&json).expect("json")
        }
        "seedsDrainRejection" => {
            let candidate = parse_candidate(&c["candidate"]);
            let cfg = parse_cfg(&c["cfg"]);
            reason_str(seeds_drain_rejection(&candidate, &cfg).map(|r| r.as_str()))
        }
        "streamTitleBytes" => {
            let title = c["title"].as_str();
            num_str(stream_title_bytes(title))
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
    assert_eq!(m.output.path, "rust/golden/autofetch-policy.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-autofetch-policy.json");
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
    assert_eq!(cases.len(), 72, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
