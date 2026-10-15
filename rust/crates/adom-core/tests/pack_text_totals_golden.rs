//! Golden de `src/providers/pack-text-totals.ts` →
//! `adom-core::pack_text_totals` e de `src/providers/duplicate-pack.ts` →
//! `adom-core::duplicate_pack`.
//!
//! O `expected` veio do dist vivo pelos oráculos
//! `scripts/golden/pack-text-totals-oracle.mjs` e
//! `scripts/golden/duplicate-pack-oracle.mjs`: string canônica por caso
//! (JSON canônico com chaves ordenadas, números no formato do
//! `JSON.stringify`). A caixa do Node (`recordFileSizes`) é reproduzida no
//! `boundary_files`: filtro de tamanho 0/não-vídeo/sample/propaganda e hash
//! minúsculo — é a MESMA fronteira que alimenta o módulo em produção.

mod common;

use std::collections::{HashMap, HashSet};

use adom_core::{
    drop_duplicate_pack_files, drop_pack_text_totals, files_prove_pack, is_sample, is_site_ad,
    is_video, names_multiple_episodes, DuplicatePackInput, PackTextTotalsInput, RankingStream,
    MANIFEST_FORMAT,
};
use serde_json::{Map, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const PTT_JSONL: &[u8] = include_bytes!("../../../golden/pack-text-totals.jsonl");
const PTT_MANIFEST: &str = include_str!("../../../golden/pack-text-totals.manifest.json");
const PTT_CORPUS: &str = include_str!("../../../../scripts/golden/corpus-pack-text-totals.json");
const DUP_JSONL: &[u8] = include_bytes!("../../../golden/duplicate-pack.jsonl");
const DUP_MANIFEST: &str = include_str!("../../../golden/duplicate-pack.manifest.json");
const DUP_CORPUS: &str = include_str!("../../../../scripts/golden/corpus-duplicate-pack.json");

const PTT_REGISTRY: &str = "pack-text-totals/dropPackTextTotals";
const DUP_REGISTRY: &str = "duplicate-pack/dropDuplicatePackFiles";
const PTT_CASES: usize = 35;
const DUP_CASES: usize = 14;

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

fn canon_string(root: Value) -> String {
    let mut text = String::new();
    js_canon(&root, &mut text);
    text
}

fn parse_streams(v: &Value) -> Vec<RankingStream> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|s| {
                    serde_json::from_value(s.clone())
                        .expect("stream do corpus desserializa no RankingStream")
                })
                .collect()
        })
        .unwrap_or_default()
}

/// A caixa do `recordFileSizes` do Node: `Number(size) || 0`, filtro de
/// vídeo/sample/propaganda, hash minúsculo, lista vazia = hash sem lista.
fn boundary_files(files: &Value) -> Option<Vec<adom_core::DebridFile>> {
    let raw = files.as_array()?;
    let videos: Vec<adom_core::DebridFile> = raw
        .iter()
        .map(|item| adom_core::DebridFile {
            path: item
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            size: item.get("size").and_then(Value::as_f64).unwrap_or(0.0),
        })
        .filter(|file| {
            file.size > 0.0
                && is_video(&file.path)
                && !is_sample(&file.path)
                && !is_site_ad(&file.path)
        })
        .collect();
    if videos.is_empty() {
        None
    } else {
        Some(videos)
    }
}

/// `files: [{ hash, files }]` do corpus → mapa hash minúsculo → lista filtrada.
fn files_map(v: Option<&Value>) -> HashMap<String, Vec<adom_core::DebridFile>> {
    let mut map = HashMap::new();
    if let Some(entries) = v.and_then(Value::as_array) {
        for entry in entries {
            let hash = entry
                .get("hash")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            if hash.is_empty() {
                continue;
            }
            if let Some(files) = entry.get("files").and_then(boundary_files) {
                map.insert(hash, files);
            }
        }
    }
    map
}

fn opt_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

fn render_ptt(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    match c["op"].as_str().expect("campo op") {
        "namesMultipleEpisodes" => {
            let title = c["title"].as_str().unwrap_or("");
            if names_multiple_episodes(title) {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        "looksPackByFiles" => {
            // `recordFileSizes(hash, files)` do Node grava por hash minúsculo e
            // o corpus usa hashes minúsculos; lista vazia = hash SEM lista.
            let files = c.get("files").and_then(boundary_files);
            if files_prove_pack(files.as_deref()) {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        "dropPackTextTotals" => {
            let input = PackTextTotalsInput {
                streams: parse_streams(&c["streams"]),
                season: opt_i64(&c, "season"),
                episode: opt_i64(&c, "episode"),
                files: files_map(c.get("files")),
            };
            let out = drop_pack_text_totals(&input);
            let mut root = Map::new();
            root.insert(
                "streams".to_string(),
                serde_json::to_value(&out.streams).expect("streams serializam"),
            );
            root.insert(
                "packTextDropped".to_string(),
                Value::from(out.pack_text_dropped),
            );
            canon_string(Value::Object(root))
        }
        other => panic!("op desconhecida no golden pack-text-totals: {other}"),
    }
}

fn render_dup(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let work = c.get("work").filter(|w| !w.is_null());
    let input = DuplicatePackInput {
        streams: parse_streams(&c["streams"]),
        season: opt_i64(&c, "season"),
        episode: opt_i64(&c, "episode"),
        work_names: work
            .and_then(|w| w.get("n"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        work_year: work.and_then(|w| w.get("y")).and_then(Value::as_i64),
        cached: c
            .get("cached")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<HashSet<_>>()
            })
            .unwrap_or_default(),
        files: files_map(c.get("files")),
    };
    let out = drop_duplicate_pack_files(&input);
    let mut root = Map::new();
    root.insert(
        "streams".to_string(),
        serde_json::to_value(&out.streams).expect("streams serializam"),
    );
    root.insert(
        "drops".to_string(),
        serde_json::to_value(&out.drops).expect("drops serializam"),
    );
    canon_string(Value::Object(root))
}

// ── pack-text-totals ─────────────────────────────────────────────────────

#[test]
fn ptt_manifest_registro_formato_e_contagem_batem() {
    let m = manifest(PTT_MANIFEST);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![PTT_REGISTRY.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(PTT_JSONL).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/pack-text-totals.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-pack-text-totals.json");
}

#[test]
fn ptt_hashes_sha256_batem_com_o_manifest() {
    let m = manifest(PTT_MANIFEST);
    assert_eq!(sha256_hex(PTT_JSONL), m.output.sha256);
    assert_eq!(sha256_hex(PTT_CORPUS.as_bytes()), m.corpus.sha256);
}

#[test]
fn ptt_ids_unicos_e_corpus_concorda_com_o_golden() {
    let cases = parse_cases(PTT_JSONL);
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    assert_corpus_matches(PTT_CORPUS, &cases);
}

#[test]
fn ptt_saidas_batem_com_o_golden_caso_a_caso() {
    let cases = parse_cases(PTT_JSONL);
    assert_eq!(cases.len(), PTT_CASES, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render_ptt(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}

// ── duplicate-pack ───────────────────────────────────────────────────────

#[test]
fn dup_manifest_registro_formato_e_contagem_batem() {
    let m = manifest(DUP_MANIFEST);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![DUP_REGISTRY.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(DUP_JSONL).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/duplicate-pack.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-duplicate-pack.json");
}

#[test]
fn dup_hashes_sha256_batem_com_o_manifest() {
    let m = manifest(DUP_MANIFEST);
    assert_eq!(sha256_hex(DUP_JSONL), m.output.sha256);
    assert_eq!(sha256_hex(DUP_CORPUS.as_bytes()), m.corpus.sha256);
}

#[test]
fn dup_ids_unicos_e_corpus_concorda_com_o_golden() {
    let cases = parse_cases(DUP_JSONL);
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    assert_corpus_matches(DUP_CORPUS, &cases);
}

#[test]
fn dup_saidas_batem_com_o_golden_caso_a_caso() {
    let cases = parse_cases(DUP_JSONL);
    assert_eq!(cases.len(), DUP_CASES, "contagem de casos do corpus mudou");
    for case in &cases {
        let obtido = render_dup(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
