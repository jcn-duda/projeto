//! Integridade e paridade do golden das guardas de dublagem por path de
//! `audio-cleanup.ts`: `hasPtAudioMark`, `strongEnSceneMark`,
//! `dnContradictsDubClaim`, `enSceneMirrorTitle` e `dubbedLieVerdict`.
//!
//! A saída é `"1"`/`"0"`, o grupo casado (ou `""`) para `enscene`, e
//! `lie|grupo|videoCount` para `lie` — exatamente o que o oráculo Node grava.
//! As listas calibradas e o `enabled` vêm do bloco `config` do corpus: as
//! funções Rust recebem-nas por parâmetro (não leem `config.*`).

mod common;

use std::collections::HashSet;

use adom_core::{
    dn_contradicts_dub_claim, dubbed_lie_verdict, en_scene_mirror_title, has_pt_audio_mark,
    strong_en_scene_mark, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/audio-cleanup-verdicts.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/audio-cleanup-verdicts.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-audio-cleanup-verdicts.json");

const REGISTRY_MATCH: &str = "audio-cleanup-verdicts/audioCleanupVerdicts";

struct Config {
    enabled: bool,
    pt_markers: Vec<String>,
    en_groups: Vec<String>,
}

fn config() -> Config {
    let corpus: Value = serde_json::from_str(CORPUS_TEXT).expect("corpus JSON válido");
    let cfg = &corpus["config"];
    let strings = |key: &str| -> Vec<String> {
        cfg[key]
            .as_array()
            .unwrap_or_else(|| panic!("config.{key}: array"))
            .iter()
            .map(|v| v.as_str().expect("config: string").to_string())
            .collect()
    };
    Config {
        enabled: cfg["enabled"].as_bool().expect("config.enabled"),
        pt_markers: strings("ptMarkers"),
        en_groups: strings("enGroups"),
    }
}

fn bit(v: bool) -> &'static str {
    if v {
        "1"
    } else {
        "0"
    }
}

fn render(input: &str, cfg: &Config) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let pt: Vec<&str> = cfg.pt_markers.iter().map(String::as_str).collect();
    let en: Vec<&str> = cfg.en_groups.iter().map(String::as_str).collect();
    match c["op"].as_str().expect("campo op") {
        "ptmark" => bit(has_pt_audio_mark(
            c["path"].as_str().expect("campo path"),
            &pt,
        ))
        .to_string(),
        "enscene" => strong_en_scene_mark(c["path"].as_str().expect("campo path"), &pt, &en)
            .unwrap_or("")
            .to_string(),
        "dn" => bit(dn_contradicts_dub_claim(
            c["dn"].as_str().expect("campo dn"),
            cfg.enabled,
            &pt,
            &en,
        ))
        .to_string(),
        "mirror" => bit(en_scene_mirror_title(
            c["title"].as_str().expect("campo title"),
            &pt,
            &en,
        ))
        .to_string(),
        "lie" => {
            let paths: Vec<&str> = c["paths"]
                .as_array()
                .expect("campo paths")
                .iter()
                .map(|v| v.as_str().expect("path string"))
                .collect();
            let promised = c["promisedDubbed"].as_bool().expect("campo promisedDubbed");
            let r = dubbed_lie_verdict(&paths, promised, cfg.enabled, &pt, &en);
            format!(
                "{}|{}|{}",
                bit(r.lie),
                r.matched_group.as_deref().unwrap_or(""),
                r.video_count
            )
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
    assert_eq!(m.output.path, "rust/golden/audio-cleanup-verdicts.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-audio-cleanup-verdicts.json"
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
fn predicados_batem_com_o_golden_caso_a_caso() {
    let cfg = config();
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input, &cfg);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
