//! Golden de `sortAndLimit` (`src/utils/stream-ranking.ts`) →
//! `adom-core::stream_ranking_sort`.
//!
//! O `expected` veio do dist vivo pelo oráculo
//! `scripts/golden/sort-and-limit-oracle.mjs`: JSON canônico (chaves
//! ordenadas, números no formato do `JSON.stringify`) de `{ streams, drops }`,
//! com `drops` = `trace.items` sem o `id` posicional. O waiver do piso viaja
//! MARCADO nos streams de saída (`_seedFloorWaived`), como no TS — a lista
//! `waived_hashes` e o flag `quality_relaxed` são leituras derivadas, não
//! participa do contrato de bytes do golden.

mod common;

use std::collections::HashSet;

use adom_core::{sort_and_limit, RankingStream, SortInput, SortOptions, MANIFEST_FORMAT};
use serde_json::{Map, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/stream-ranking-sort.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/stream-ranking-sort.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-sort-and-limit.json");

const REGISTRY_MATCH: &str = "stream-ranking/sortAndLimit";
const CASES: usize = 79;

/// Número no formato do `JSON.stringify` do JS (inteiro sem casas).
fn js_num(n: f64) -> String {
    if n == 0.0 {
        return "0".to_string(); // cobre -0
    }
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        serde_json::to_string(&n).expect("f64 finito serializa")
    }
}

/// JSON canônico: chaves ordenadas, sem espaços — o mesmo contrato do oráculo.
fn js_canon(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&js_num(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("string serializa")),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                js_canon(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("chave serializa"));
                out.push(':');
                js_canon(&map[*key], out);
            }
            out.push('}');
        }
    }
}

fn parse_streams(v: &Value) -> Vec<RankingStream> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    // O corpus pode carregar `null` (o TS aceita e filtra).
                    if s.is_null() {
                        None
                    } else {
                        Some(
                            serde_json::from_value(s.clone())
                                .expect("stream do corpus desserializa no RankingStream"),
                        )
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_options(c: &Value) -> SortOptions {
    let o = &c["options"];
    let arr = |key: &str| -> Vec<String> {
        o[key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let limits = |key: &str| -> std::collections::HashMap<String, f64> {
        o[key]
            .as_object()
            .map(|m| {
                m.iter()
                    .map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0)))
                    .collect()
            })
            .unwrap_or_default()
    };
    SortOptions {
        min_seeders: o["minSeeders"].as_f64().unwrap_or(0.0),
        max_results: o["maxResults"].as_f64().unwrap_or(40.0),
        quality_filter: arr("qualityFilter"),
        season: o["season"].as_i64(),
        episode: o["episode"].as_i64(),
        prefer_dubbed: o["preferDubbed"].as_bool().unwrap_or(false),
        dubbed_only: o["dubbedOnly"].as_bool().unwrap_or(false),
        exclude_cam: o["excludeCam"].as_bool().unwrap_or(false),
        max_size_gb: o["maxSizeGb"].as_f64().unwrap_or(0.0),
        quality_limits: limits("qualityLimits"),
        br_reserved_slots: o["brReservedSlots"].as_f64().unwrap_or(0.0),
        br_reserved_per_quality: o["brReservedPerQuality"].as_f64().unwrap_or(0.0),
        candidate_factor: o["candidateFactor"].as_f64().unwrap_or(1.0),
        br_first: o["brFirst"].as_bool().unwrap_or(true),
        indexer_priority: arr("indexerPriority"),
    }
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let instant_hashes: HashSet<String> = c["instantHashes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let out = sort_and_limit(&SortInput {
        streams: parse_streams(&c["streams"]),
        options: parse_options(&c),
        instant_hashes,
    });
    // Leituras derivadas do contrato: `waived_hashes`/`quality_relaxed` são
    // métricas para o chamador; a paridade de BYTES é sobre { streams, drops }.
    let mut root = Map::new();
    root.insert(
        "streams".to_string(),
        serde_json::to_value(&out.streams).expect("streams serializam"),
    );
    root.insert(
        "drops".to_string(),
        serde_json::to_value(&out.drops).expect("drops serializam"),
    );
    let mut text = String::new();
    js_canon(&Value::Object(root), &mut text);
    text
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/stream-ranking-sort.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-sort-and-limit.json");
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
    assert_eq!(cases.len(), CASES, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}

#[test]
fn waiver_marcado_e_lista_de_hashes_concordam() {
    // Caso s-06: BR dublado com 0 seeds sobrevive ao piso MARCADO; o global
    // sem waiver morre. A lista `waived_hashes` reflete só quem sobreviveu.
    let cases = parse_cases(JSONL_BYTES);
    let case = cases
        .iter()
        .find(|c| c.id == "s-06")
        .expect("caso do waiver presente");
    let c: Value = serde_json::from_str(&case.input).expect("entrada válida");
    let out = sort_and_limit(&SortInput {
        streams: parse_streams(&c["streams"]),
        options: parse_options(&c),
        instant_hashes: HashSet::new(),
    });
    assert_eq!(out.streams.len(), 2);
    assert_eq!(out.waived_hashes.len(), 1, "só o BR dublado tem waiver");
    assert!(out
        .streams
        .iter()
        .any(|s| s.extra.contains_key("_seedFloorWaived")));
}

#[test]
fn quality_relaxed_flag_e_ultimo_recurso() {
    let cases = parse_cases(JSONL_BYTES);
    let case = cases
        .iter()
        .find(|c| c.id == "s-13")
        .expect("caso do último recurso presente");
    let c: Value = serde_json::from_str(&case.input).expect("entrada válida");
    let out = sort_and_limit(&SortInput {
        streams: parse_streams(&c["streams"]),
        options: parse_options(&c),
        instant_hashes: HashSet::new(),
    });
    assert!(out.quality_relaxed, "SD reaberto como último recurso");
    assert_eq!(out.streams.len(), 1);
}
