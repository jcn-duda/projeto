//! Golden de `stream_quotas_extra`: qualityFromTitle, limitByQuality,
//! limitByQualityAndIndexer e selectQualityCandidates.
//!
//! Cada linha do JSONL tem `op` indicando a função. O `input` é um JSON com os
//! parâmetros; `expected` é o resultado esperado (string para quality, array de
//! índices para as demais).

mod common;

use std::collections::HashSet;

use adom_core::stream_quotas_extra::{
    limit_by_quality, limit_by_quality_and_indexer, quality_from_title, select_quality_candidates,
    QualityLimits, SelectCandidatesOpts, StreamRef,
};

use common::parse_cases;
use serde_json::Value;

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/stream-quotas-extra.jsonl");

fn make_stream(quality: Option<&str>, indexer: Option<&str>, is_br: bool) -> StreamRef {
    StreamRef {
        title: String::new(),
        quality: quality.map(str::to_string),
        indexer: indexer.map(str::to_string),
        is_br,
        is_dubbed: false,
        is_dub_claim: false,
        is_lied: false,
        is_season_pack: false,
    }
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("op presente") {
        "quality" => {
            let title = c["title"].as_str().expect("title");
            serde_json::to_string(quality_from_title(title)).unwrap()
        }
        "limitQuality" => {
            let streams: Vec<Value> = serde_json::from_value(c["streams"].clone()).expect("streams");
            let qualities: Vec<&str> = streams
                .iter()
                .map(|s| s["quality"].as_str().unwrap_or(""))
                .collect();
            let limits: QualityLimits = c["limits"]
                .as_object()
                .expect("limits")
                .iter()
                .map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0)))
                .collect();
            let kept = limit_by_quality(&qualities, &limits);
            format!("[{}]", kept.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(","))
        }
        "limitQualityIndexer" => {
            let streams_v: Vec<Value> = serde_json::from_value(c["streams"].clone()).expect("streams");
            let streams: Vec<StreamRef> = streams_v
                .iter()
                .map(|s| make_stream(
                    s["quality"].as_str(),
                    s["indexer"].as_str(),
                    s["isBr"].as_bool().unwrap_or(false),
                ))
                .collect();
            let refs: Vec<&StreamRef> = streams.iter().collect();
            let ql: QualityLimits = c["qualityLimits"]
                .as_object()
                .expect("ql")
                .iter()
                .map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0)))
                .collect();
            let il: QualityLimits = c["indexerLimits"]
                .as_object()
                .expect("il")
                .iter()
                .map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0)))
                .collect();
            let exempt: HashSet<usize> = c["exempt"]
                .as_array()
                .expect("exempt")
                .iter()
                .map(|v| v.as_u64().expect("idx") as usize)
                .collect();
            let rbr: HashSet<usize> = c["reservedBr"]
                .as_array()
                .expect("rbr")
                .iter()
                .map(|v| v.as_u64().expect("idx") as usize)
                .collect();
            let max_pi = c["maxPerIndexer"].as_f64().unwrap_or(0.0);
            let kept = limit_by_quality_and_indexer(&refs, &ql, max_pi, &exempt, &il, &rbr);
            format!("[{}]", kept.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(","))
        }
        "selectCandidates" => {
            let streams_v: Vec<Value> = serde_json::from_value(c["streams"].clone()).expect("streams");
            let streams: Vec<StreamRef> = streams_v
                .iter()
                .map(|s| {
                    let mut sr = make_stream(s["quality"].as_str(), None, s["isBr"].as_bool().unwrap_or(false));
                    sr.is_lied = s["isLied"].as_bool().unwrap_or(false);
                    sr
                })
                .collect();
            let refs: Vec<&StreamRef> = streams.iter().collect();
            let ql: QualityLimits = c["qualityLimits"]
                .as_object()
                .expect("ql")
                .iter()
                .map(|(k, v)| (k.clone(), v.as_f64().unwrap_or(0.0)))
                .collect();
            let opts = SelectCandidatesOpts {
                max_results: c["maxResults"].as_f64().unwrap_or(40.0),
                quality_limits: ql,
                br_reserved_slots: c["brReservedSlots"].as_f64().unwrap_or(0.0),
                br_reserved_per_quality: c["brReservedPerQuality"].as_f64().unwrap_or(0.0),
                candidate_factor: c["candidateFactor"].as_f64().unwrap_or(1.0),
                br_first: c["brFirst"].as_bool().unwrap_or(true),
            };
            let kept = select_quality_candidates(&refs, &opts);
            format!("[{}]", kept.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(","))
        }
        other => panic!("op desconhecida: {other}"),
    }
}

#[test]
fn golden_ids_unicos_e_minimum_cases() {
    let cases = parse_cases(JSONL_BYTES);
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.clone()), "id duplicado: {}", case.id);
    }
    assert!(cases.len() >= 20, "golden precisa de pelo menos 20 casos");
}

#[test]
fn golden_saidas_batem_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
