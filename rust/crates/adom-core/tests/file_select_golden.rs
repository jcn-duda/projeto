//! Paridade do seletor de arquivo com o oráculo Node (`file_select.json`).
//!
//! `workCoverage` é float: números comparam com tolerância 1e-9. Listas
//! (episódios declarados, amostras) comparam na ordem de inserção.

use adom_core::{
    base_name, is_site_ad, looks_multi_work_files, pick_code_label, pick_file, pick_work_file,
    work_coverage, DebridFile, EpisodeContext, EpisodeEvidence, PickOutcome, PlayHint, WorkHint,
};
use serde_json::Value;

const GOLDEN: &str = include_str!("golden/file_select.json");

fn num(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        let number = value.as_f64()?;
        (number.fract() == 0.0).then_some(number as i64)
    })
}

fn opt_i64(obj: &Value, key: &str) -> Option<i64> {
    match obj.get(key) {
        None | Some(Value::Null) => None,
        Some(value) => num(value),
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn files_of(value: &Value) -> Vec<DebridFile> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| DebridFile {
                    path: item
                        .get("path")
                        .and_then(|path| path.as_str())
                        .unwrap_or("")
                        .to_string(),
                    size: item
                        .get("size")
                        .and_then(|size| size.as_f64())
                        .unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn hint_of(entry: &Value) -> PlayHint {
    let Some(hint) = entry.get("hint").filter(|value| value.is_object()) else {
        return PlayHint::default();
    };
    let work = hint
        .get("work")
        .filter(|value| value.is_object())
        .map(|work| WorkHint {
            names: work.get("names").map(strings).unwrap_or_default(),
            year: opt_i64(work, "year"),
            pack: work
                .get("pack")
                .and_then(|flag| flag.as_bool())
                .unwrap_or(false),
        });
    PlayHint {
        season: opt_i64(hint, "season"),
        episode: opt_i64(hint, "episode"),
        work,
        dubbed: false,
    }
}

fn evidence_json(evidence: &EpisodeEvidence) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("wantedSeason".into(), Value::from(evidence.wanted_season));
    obj.insert("wantedEpisode".into(), Value::from(evidence.wanted_episode));
    obj.insert(
        "declaredSeasons".into(),
        Value::from(evidence.declared_seasons.clone()),
    );
    obj.insert(
        "declaredEpisodes".into(),
        Value::from(evidence.declared_episodes.clone()),
    );
    if let Some(sample) = &evidence.sample {
        obj.insert("sample".into(), Value::from(sample.clone()));
    }
    Value::Object(obj)
}

fn context_json(context: &EpisodeContext) -> Value {
    serde_json::json!({
        "videoCount": context.video_count,
        "samples": context.samples,
    })
}

fn outcome_json(outcome: &PickOutcome) -> Value {
    match outcome {
        PickOutcome::Empty => serde_json::json!({ "kind": "null" }),
        PickOutcome::File { path, size } => {
            serde_json::json!({ "kind": "file", "path": path, "size": size })
        }
        PickOutcome::Error {
            code,
            evidence,
            context,
        } => {
            let mut obj = serde_json::Map::new();
            obj.insert("kind".into(), Value::from("error"));
            obj.insert("code".into(), Value::from(pick_code_label(*code)));
            obj.insert(
                "evidence".into(),
                evidence.as_ref().map(evidence_json).unwrap_or(Value::Null),
            );
            obj.insert(
                "context".into(),
                context.as_ref().map(context_json).unwrap_or(Value::Null),
            );
            Value::Object(obj)
        }
    }
}

fn run(entry: &Value) -> Value {
    match entry["op"].as_str().expect("op") {
        "pickFile" => outcome_json(&pick_file(&files_of(&entry["files"]), &hint_of(entry))),
        "pickWorkFile" => {
            let names = strings(&entry["names"]);
            match pick_work_file(&files_of(&entry["files"]), &names, opt_i64(entry, "year")) {
                None => serde_json::json!({ "kind": "null" }),
                Some(file) => outcome_json(&PickOutcome::File {
                    path: file.path,
                    size: file.size,
                }),
            }
        }
        "workCoverage" => {
            let value = work_coverage(
                entry["fileName"].as_str().unwrap_or(""),
                entry["name"].as_str().unwrap_or(""),
            );
            serde_json::json!({ "kind": "number", "value": value })
        }
        "looksMultiWorkFiles" => {
            serde_json::json!({ "kind": "bool", "value": looks_multi_work_files(&files_of(&entry["files"])) })
        }
        "isSiteAd" => {
            serde_json::json!({ "kind": "bool", "value": is_site_ad(entry["path"].as_str().unwrap_or("")) })
        }
        "baseName" => {
            serde_json::json!({ "kind": "string", "value": base_name(entry["path"].as_str().unwrap_or("")) })
        }
        other => panic!("op desconhecida: {other}"),
    }
}

fn near(got: &Value, expected: &Value) -> bool {
    match (got, expected) {
        (Value::Number(left), Value::Number(right)) => {
            let a = left.as_f64().unwrap_or(f64::NAN);
            let b = right.as_f64().unwrap_or(f64::NAN);
            (a - b).abs() <= 1e-9
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| near(a, b))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| near(value, other)))
        }
        _ => got == expected,
    }
}

#[test]
fn file_select_bate_com_o_oraculo() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden JSON");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() > 40, "golden curto demais: {}", cases.len());
    let mut ids = Vec::new();
    for entry in cases {
        let id = entry["id"].as_str().expect("id").to_string();
        let got = run(entry);
        assert!(
            near(&got, &entry["out"]),
            "{id}\n got={got}\n exp={}",
            entry["out"]
        );
        ids.push(id);
    }
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), cases.len(), "id repetido no golden");
}
