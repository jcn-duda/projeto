//! Runner: replay 51/51, divergência fabricada, erro de fonte e CLI.

mod common;

use std::process::Command;

use adom_parity::{run_corpus, Case, NormalizeOptions, ReplaySource, SourceError, StreamSource};
use serde_json::{json, Value};

#[test]
fn replay_do_corpus_inteiro_bate_51_de_51() {
    let corpus = common::corpus();
    let report = run_corpus(
        corpus,
        &ReplaySource as &dyn StreamSource,
        &NormalizeOptions::default(),
    );
    assert_eq!(report.compared(), 51, "{report}");
    assert_eq!(report.matched(), 51, "{report}");
    assert_eq!(report.diverged(), 0, "{report}");
    assert_eq!(report.skipped(), 0, "{report}");
    assert_eq!(report.corpus_errors(), 0, "{report}");
    assert_eq!(report.source_errors(), 0, "{report}");
    assert!(report.is_perfect(), "{report}");
}

#[test]
fn divergencia_fabricada_e_detectada_pelo_runner() {
    let corpus = common::corpus();
    let source = |case: &Case| -> Result<Value, SourceError> {
        let mut body = case.response.body.clone().unwrap_or(Value::Null);
        if case.meta.id == "movie-matrix" {
            body["streams"][0]["title"] = json!("MUTADO PELO TESTE");
        }
        Ok(body)
    };
    let report = run_corpus(
        corpus,
        &source as &dyn StreamSource,
        &NormalizeOptions::default(),
    );
    assert_eq!(report.diverged(), 1, "{report}");
    assert_eq!(report.matched(), 50, "{report}");
    let text = report.to_string();
    assert!(text.contains("DIVERGE movie-matrix"), "{text}");
    assert!(text.contains("title"), "{text}");
}

#[test]
fn erro_de_fonte_nao_conta_como_divergencia() {
    let corpus = common::corpus();
    let source = |_case: &Case| Err(SourceError::new("timeout simulado"));
    let report = run_corpus(
        corpus,
        &source as &dyn StreamSource,
        &NormalizeOptions::default(),
    );
    assert_eq!(report.diverged(), 0, "{report}");
    assert_eq!(report.source_errors(), 51, "{report}");
    assert_eq!(report.compared(), 0, "{report}");
}

#[test]
fn binario_dump_valida_o_corpus() {
    let output = Command::new(env!("CARGO_BIN_EXE_adom-parity"))
        .arg("--dump")
        .output()
        .expect("binário adom-parity");
    assert!(
        output.status.success(),
        "stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("casos: 51"), "{stdout}");
    assert!(stdout.contains("itens de stream: 314"), "{stdout}");
    assert!(stdout.contains("arquivos por etapa: 0"), "{stdout}");
}

#[test]
fn binario_dump_json_serializa_o_retrato() {
    let output = Command::new(env!("CARGO_BIN_EXE_adom-parity"))
        .args(["--dump", "--json"])
        .output()
        .expect("binário adom-parity");
    assert!(output.status.success());
    let value: Value = serde_json::from_slice(&output.stdout).expect("--dump --json deve ser JSON");
    assert_eq!(value["stats"]["loaded_cases"], json!(51));
    assert_eq!(value["format"], json!("adom-stream-e2e/1"));
    assert!(value["diagnostics"].is_array());
}

#[test]
fn binario_replay_bate_e_sai_zero() {
    let output = Command::new(env!("CARGO_BIN_EXE_adom-parity"))
        .arg("--replay")
        .output()
        .expect("binário adom-parity");
    assert!(
        output.status.success(),
        "stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("51 comparado(s)"), "{stdout}");
    assert!(stdout.contains("51 igual(ais)"), "{stdout}");
    assert!(stdout.contains("0 divergente(s)"), "{stdout}");
}

#[test]
fn binario_dump_de_corpus_temperado_sai_um() {
    let dir = common::TempDir::new("temperado-binario");
    dir.write(
        "manifest.json",
        r#"{"format":"adom-stream-e2e/1","cases":[]}"#,
    );
    let output = Command::new(env!("CARGO_BIN_EXE_adom-parity"))
        .args(["--dump", "--corpus"])
        .arg(dir.path())
        .output()
        .expect("binário adom-parity");
    assert_eq!(output.status.code(), Some(1));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("panicked"));
}
