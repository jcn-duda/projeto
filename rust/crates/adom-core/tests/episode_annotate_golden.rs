//! Golden dos núcleos puros de `src/providers/episode-size.ts`
//! (`episodesCovered`, `exactEpisodeBytes`, `annotatePackSizes`,
//! `annotateMovieSizes`, `fillMissingSizes`, `fillTorrentTotals`) →
//! `adom_core::episode_annotate`.
//!
//! O `expected` veio do dist vivo pelo oráculo
//! `scripts/golden/episode-annotate-oracle.mjs`: contagem ("96"), bytes
//! ("5261334937.6") ou JSON canônico (chaves ordenadas, números no formato do
//! `JSON.stringify`) da projeção dos streams (`_indexer`, `_multiWork`,
//! `_multiWorkAdmitted`, `_packBytes`, `_size`, `name`, `title`).

mod common;

use std::collections::{BTreeMap, HashSet};

use adom_core::{
    annotate_movie_sizes_core, annotate_pack_sizes_core, episodes_covered, exact_episode_bytes,
    fill_missing_sizes_core, fill_torrent_totals_core, DebridFile, FillOpts, PackOpts,
    RankingStream, WorkHint, MANIFEST_FORMAT,
};
use serde_json::{Map, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/episode-annotate.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/episode-annotate.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-episode-annotate.json");

const REGISTRY_MATCH: &str = "episode-annotate/episodeAnnotate";
const CASES: usize = 61;

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

fn parse_meta(v: &Value) -> Vec<(i64, i64)> {
    v.as_object()
        .map(|m| {
            m.iter()
                .map(|(s, n)| {
                    (
                        s.parse::<i64>().expect("temporada"),
                        n.as_i64().unwrap_or(0),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_files(v: &Value) -> Vec<DebridFile> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|f| DebridFile {
                    path: f["path"].as_str().expect("path").to_string(),
                    size: f["size"].as_f64().expect("size"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_files_by_hash(v: &Value) -> BTreeMap<String, Vec<DebridFile>> {
    v.as_object()
        .map(|m| {
            m.iter()
                .map(|(hash, files)| (hash.to_lowercase(), parse_files(files)))
                .collect()
        })
        .unwrap_or_default()
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

fn parse_work(v: &Value) -> WorkHint {
    WorkHint {
        names: v["n"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        year: v["y"].as_i64(),
        pack: true,
    }
}

/// Projeção canônica do oráculo: só as chaves que os núcleos leem/escrevem.
fn project(streams: &[RankingStream]) -> String {
    let items: Vec<Value> = streams
        .iter()
        .map(|s| {
            let mut m = Map::new();
            if let Some(v) = &s.indexer {
                m.insert("_indexer".to_string(), Value::from(v.as_str()));
            }
            if let Some(v) = s.multi_work {
                m.insert("_multiWork".to_string(), Value::from(v));
            }
            if let Some(v) = s.multi_work_admitted {
                m.insert("_multiWorkAdmitted".to_string(), Value::from(v));
            }
            if let Some(v) = s.extra.get("_packBytes") {
                m.insert("_packBytes".to_string(), v.clone());
            }
            if let Some(v) = s.size {
                m.insert("_size".to_string(), serde_json::json!(v));
            }
            if let Some(v) = &s.name {
                m.insert("name".to_string(), Value::from(v.as_str()));
            }
            if let Some(v) = &s.title {
                m.insert("title".to_string(), Value::from(v.as_str()));
            }
            Value::Object(m)
        })
        .collect();
    let mut out = String::new();
    js_canon(&Value::Array(items), &mut out);
    out
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let files = parse_files_by_hash(&c["files"]);
    match c["op"].as_str().expect("campo op") {
        "covered" => episodes_covered(
            c["title"].as_str().expect("title"),
            c["season"].as_i64().expect("season"),
            &parse_meta(&c["meta"]),
        )
        .to_string(),
        "exact" => exact_episode_bytes(
            &parse_files(&c["files"]),
            c["season"].as_i64().expect("season"),
            c["episode"].as_i64().expect("episode"),
        )
        .map(js_num)
        .unwrap_or_else(|| "0".to_string()),
        "pack" => {
            let opts = PackOpts {
                season: c["season"].as_i64().expect("season"),
                episode: c["episode"].as_i64().expect("episode"),
                meta: &parse_meta(&c["meta"]),
            };
            project(&annotate_pack_sizes_core(
                &parse_streams(&c["streams"]),
                &files,
                &opts,
            ))
        }
        "movie" => {
            let work = parse_work(&c["work"]);
            project(&annotate_movie_sizes_core(
                &parse_streams(&c["streams"]),
                &files,
                &work,
            ))
        }
        "fill" => {
            let work = if c["work"].is_null() {
                None
            } else {
                Some(parse_work(&c["work"]))
            };
            let opts = FillOpts {
                season: c["season"].as_i64(),
                episode: c["episode"].as_i64(),
                work: work.as_ref(),
            };
            project(&fill_missing_sizes_core(
                &parse_streams(&c["streams"]),
                &files,
                &opts,
            ))
        }
        "totals" => {
            let totals: BTreeMap<String, f64> = c["totals"]
                .as_object()
                .map(|m| {
                    m.iter()
                        .map(|(h, n)| (h.to_lowercase(), n.as_f64().unwrap_or(0.0)))
                        .collect()
                })
                .unwrap_or_default();
            project(&fill_torrent_totals_core(
                &parse_streams(&c["streams"]),
                &files,
                &totals,
            ))
        }
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
    assert_eq!(m.output.path, "rust/golden/episode-annotate.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-episode-annotate.json");
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
