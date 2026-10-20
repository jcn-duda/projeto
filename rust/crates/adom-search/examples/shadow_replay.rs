//! Harness de diagnóstico da sombra congelada: classifica as divergências da
//! janela §9.4 (Node × replay Rust) em JSON (`case`, `expected`, `got`).
//!
//! Uso (host):
//!   SHADOW_CASES=E:/stremio\ adom/.tmp-shadow-current \
//!   SHADOW_JSON=divergencias.json \
//!   cargo run -p adom-search --example shadow_replay
//!
//! Não é gate: serve para medir/classificar, nunca altera caso ou container.

use std::io::Write;
use std::path::PathBuf;

use adom_search::orchestrator::frozen_gate;
use serde_json::{json, Value};

#[tokio::main]
async fn main() {
    let root = std::env::var("SHADOW_CASES")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("../../.tmp-shadow-current"));
    let out_path = std::env::var("SHADOW_JSON").ok();
    let only: Vec<String> = std::env::var("SHADOW_ONLY")
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&root)
        .unwrap_or_else(|err| panic!("SHADOW_CASES {}: {err}", root.display()))
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.join("request.json").is_file())
        .filter(|path| {
            only.is_empty()
                || path
                    .file_name()
                    .is_some_and(|name| only.iter().any(|id| name.to_string_lossy().contains(id)))
        })
        .collect();
    dirs.sort();
    let total = dirs.len();
    let mut ok = 0usize;
    let mut diverged = 0usize;
    let mut errors = 0usize;
    let mut records: Vec<Value> = Vec::new();
    for dir in &dirs {
        let name = dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let expected_path = dir.join("expected/node-response.json");
        let expected: Value = match std::fs::read_to_string(&expected_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
        {
            Some(value) => value,
            None => {
                println!("SKIP {name}: sem expected/node-response.json");
                continue;
            }
        };
        match frozen_gate::run_case_with_expected(dir, &expected, "http://127.0.0.1:7200", "e30")
            .await
        {
            Ok(()) => ok += 1,
            Err(detail) => {
                let items = detail.lines().filter(|line| line.starts_with('#')).count();
                if items == 0 {
                    errors += 1;
                    println!("ERROR {name}: {detail}");
                    continue;
                }
                diverged += 1;
                println!("DIVERGE {name}\n{detail}\n");
                match frozen_gate::replay_case_value(dir, "http://127.0.0.1:7200", "e30").await {
                    Ok(got) => records.push(json!({
                        "case": name,
                        "expected": expected,
                        "got": got,
                    })),
                    Err(err) => println!("ERROR replay {name}: {err}"),
                }
            }
        }
    }
    if let Some(path) = out_path {
        let mut file = std::fs::File::create(&path).expect("criar SHADOW_JSON");
        file.write_all(serde_json::to_string(&records).expect("json").as_bytes())
            .expect("gravar SHADOW_JSON");
        println!("JSON={} casos={}", path, records.len());
    }
    println!("TOTAL={total} OK={ok} DIVERGE={diverged} ERROR={errors}");
}
