//! CLI do harness.
//!
//! - `adom-parity --dump` valida o corpus (manifest, sha256, esquema) e
//!   imprime o retrato do que ele realmente tem;
//! - `adom-parity --replay` roda o corpus contra ele mesmo (ReplaySource) e
//!   prova o normalizador/diff de ponta a ponta;
//! - `--json` serializa a saída; `--strict` reprova aviso também.
//!
//! O modo real (orquestrador Rust) entra quando o TODO de `runner.rs` fechar.

use std::path::PathBuf;
use std::process::ExitCode;

use adom_parity::{
    run_corpus, Corpus, DiagnosticLevel, NormalizeOptions, ParityReport, ReplaySource, StreamSource,
};
use serde_json::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Dump,
    Replay,
}

#[derive(Debug)]
struct Args {
    corpus: PathBuf,
    mode: Mode,
    json: bool,
    strict: bool,
    verbose: bool,
    ignore_cache_max_age: bool,
    base: Option<String>,
    config_segment: Option<String>,
}

fn corpus_root() -> PathBuf {
    // `adom-parity` → `crates/` → `rust/` → `golden/stream-e2e`
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../golden/stream-e2e")
}

fn usage() -> &'static str {
    "adom-parity — harness de paridade do corpus stream-e2e\n\
     \n\
     USO:\n\
       adom-parity --dump [--corpus <dir>] [--json] [--strict] [--verbose]\n\
       adom-parity --replay [--corpus <dir>] [--json]\n\
     \n\
     MODO:\n\
       --dump      valida manifest, sha256 e esquema; imprime o retrato do corpus\n\
       --replay    compara o corpus contra ele mesmo (prova normalizador + diff)\n\
     \n\
     OPÇÕES:\n\
       --corpus <dir>          raiz do corpus (default: rust/golden/stream-e2e)\n\
       --json                  saída JSON\n\
       --strict                aviso também reprova o --dump\n\
       --verbose               imprime diagnósticos info\n\
       --ignore-cache-max-age  mascara cacheMaxAge na comparação\n\
       --base <url>            origem real do addon → {{base}}\n\
       --config-segment <seg>  segmento de config do replay → {{config}}\n\
       -h, --help              esta ajuda"
}

fn main() -> ExitCode {
    match real_main() {
        Ok(code) => code,
        Err(message) => {
            eprintln!("adom-parity: {message}");
            ExitCode::from(2)
        }
    }
}

fn real_main() -> Result<ExitCode, String> {
    let Some(args) = parse_args()? else {
        println!("{}", usage());
        return Ok(ExitCode::SUCCESS);
    };
    let corpus = Corpus::load(&args.corpus).map_err(|error| error.to_string())?;
    match args.mode {
        Mode::Dump => dump(&corpus, &args),
        Mode::Replay => replay(&corpus, &args),
    }
}

fn parse_args() -> Result<Option<Args>, String> {
    let mut args = Args {
        corpus: corpus_root(),
        mode: Mode::Dump,
        json: false,
        strict: false,
        verbose: false,
        ignore_cache_max_age: false,
        base: None,
        config_segment: None,
    };
    let mut iter = std::env::args().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "-h" | "--help" => return Ok(None),
            "--dump" => args.mode = Mode::Dump,
            "--replay" => args.mode = Mode::Replay,
            "--json" => args.json = true,
            "--strict" => args.strict = true,
            "--verbose" => args.verbose = true,
            "--ignore-cache-max-age" => args.ignore_cache_max_age = true,
            "--corpus" => args.corpus = PathBuf::from(next_value(&mut iter, "--corpus")?),
            "--base" => args.base = Some(next_value(&mut iter, "--base")?),
            "--config-segment" => {
                args.config_segment = Some(next_value(&mut iter, "--config-segment")?)
            }
            value if value.starts_with("--corpus=") => {
                args.corpus = PathBuf::from(value.trim_start_matches("--corpus="))
            }
            value if value.starts_with("--base=") => {
                args.base = Some(value.trim_start_matches("--base=").to_string())
            }
            value if value.starts_with("--config-segment=") => {
                args.config_segment =
                    Some(value.trim_start_matches("--config-segment=").to_string())
            }
            other => return Err(format!("argumento desconhecido: {other}\n\n{}", usage())),
        }
    }
    Ok(Some(args))
}

fn next_value(iter: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    iter.next()
        .ok_or_else(|| format!("{flag} exige um valor\n\n{}", usage()))
}

fn dump(corpus: &Corpus, args: &Args) -> Result<ExitCode, String> {
    if args.json {
        let value = json!({
            "corpus": corpus.root.display().to_string(),
            "format": corpus.manifest.format,
            "capturedAt": corpus.manifest.captured_at,
            "node": corpus.manifest.node,
            "stats": corpus.stats,
            "diagnostics": corpus.diagnostics,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?
        );
    } else {
        print_dump(corpus, args.verbose);
    }
    let errors = corpus.count(DiagnosticLevel::Error);
    let warnings = corpus.count(DiagnosticLevel::Warning);
    if errors > 0 || (args.strict && warnings > 0) {
        Ok(ExitCode::FAILURE)
    } else {
        Ok(ExitCode::SUCCESS)
    }
}

fn print_dump(corpus: &Corpus, verbose: bool) {
    let stats = &corpus.stats;
    println!("corpus: {}", corpus.root.display());
    println!(
        "formato: {} (capturado em {}, node {})",
        corpus.manifest.format,
        corpus
            .manifest
            .captured_at
            .as_deref()
            .unwrap_or("<ausente>"),
        corpus.manifest.node.as_deref().unwrap_or("<ausente>")
    );
    println!(
        "casos: {} carregado(s) de {} no manifest (movie={}, series={}, outros={})",
        stats.loaded_cases, stats.manifest_cases, stats.movies, stats.series, stats.other_types
    );
    println!(
        "corpos: json={}, body_raw={} (listas vazias={}, avisos={}, p2p={}, debrid={})",
        stats.json_bodies,
        stats.raw_bodies,
        stats.empty_lists,
        stats.notice_cases,
        stats.p2p_cases,
        stats.debrid_cases
    );
    println!(
        "itens de stream: {} (máximo por caso={})",
        stats.stream_items, stats.max_streams
    );
    println!("campos de stream: {}", join_set(&stats.stream_fields));
    println!("headers de request: {}", join_set(&stats.request_headers));
    println!(
        "arquivos por caso: {}",
        stats
            .file_names
            .iter()
            .map(|(name, count)| format!("{name}={count}"))
            .collect::<Vec<_>>()
            .join(" ")
    );
    println!(
        "arquivos por etapa: {} ({})",
        stats.step_files,
        if stats.step_file_names.is_empty() {
            "nenhum — o corpus real não grava trace/meta/raw/debrid".to_string()
        } else {
            join_set(&stats.step_file_names)
        }
    );
    if let Some(sha) = &corpus.manifest.user_config_sha256 {
        println!("user_config_sha256: {sha}");
    }
    let errors = corpus.count(DiagnosticLevel::Error);
    let warnings = corpus.count(DiagnosticLevel::Warning);
    let infos = corpus.count(DiagnosticLevel::Info);
    println!("diagnósticos: {errors} erro(s), {warnings} aviso(s), {infos} info(s)");
    if stats.labels_missing > 0 {
        println!("casos sem label: {}", stats.labels_missing);
    }
    if !stats.manifest_extra_fields.is_empty() {
        println!(
            "campos extras no manifest: {}",
            stats.manifest_extra_fields.join(", ")
        );
    }
    if !stats.cases_with_extra_fields.is_empty() {
        println!(
            "campos extras em casos: {}",
            stats.cases_with_extra_fields.join(", ")
        );
    }
    if !corpus.manifest.not_captured.is_empty() {
        println!(
            "lacunas declaradas em notCaptured: {} (ver manifest)",
            corpus.manifest.not_captured.len()
        );
    }
    for diagnostic in &corpus.diagnostics {
        if verbose || diagnostic.level != DiagnosticLevel::Info {
            println!("{diagnostic}");
        }
    }
}

fn join_set(values: &std::collections::BTreeSet<String>) -> String {
    if values.is_empty() {
        "<nenhum>".to_string()
    } else {
        values.iter().cloned().collect::<Vec<_>>().join(", ")
    }
}

fn replay(corpus: &Corpus, args: &Args) -> Result<ExitCode, String> {
    let options = NormalizeOptions {
        base_url: args.base.clone(),
        config_segment: args.config_segment.clone(),
        mask_cache_max_age: args.ignore_cache_max_age,
        ..NormalizeOptions::default()
    };
    let report: ParityReport = run_corpus(corpus, &ReplaySource as &dyn StreamSource, &options);
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?
        );
    } else {
        print!("{report}");
    }
    if report.is_perfect() {
        Ok(ExitCode::SUCCESS)
    } else {
        Ok(ExitCode::FAILURE)
    }
}
