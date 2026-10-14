//! Integridade e paridade do golden de `src/utils/release-work.ts` (roteamento
//! de obra da release).
//!
//! Cada entrada é um JSON com `op`. `request` nulo equivale a
//! `{season: null, episode: null}`. `dn` nulo ou ausente é o mesmo que vazio
//! no TS (`!dn`). Ano `null` ou ausente chega como `""`, e número vira texto.

mod common;

use std::collections::HashSet;

use adom_core::{
    choose_episode_parse, episode_parse_specificity, parse_title_season_episode,
    release_fits_request, release_work_targets, route_work_location, ParsedSeasonEpisode,
    WorkTarget, MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/release-work.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/release-work.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-release-work.json");

const REGISTRY_MATCH: &str = "release-work/routing";

fn bit(v: bool) -> String {
    u8::from(v).to_string()
}

/// `String(x ?? '')` do JS para o ano do catálogo.
fn year_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn request(c: &Value) -> WorkTarget {
    let r = &c["request"];
    WorkTarget {
        season: r["season"].as_i64(),
        episode: r["episode"].as_i64(),
    }
}

fn seasons_text(v: &[i64]) -> String {
    v.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
}

fn parse_text(p: &ParsedSeasonEpisode) -> String {
    format!(
        "complete={} seasons={} episodes={} pack={}",
        bit(p.complete),
        seasons_text(&p.seasons),
        seasons_text(&p.episodes),
        bit(p.season_pack)
    )
}

fn part(v: Option<i64>) -> String {
    v.map_or_else(|| "-".to_string(), |n| n.to_string())
}

fn target_text(t: WorkTarget) -> String {
    format!("{}:{}", part(t.season), part(t.episode))
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let title = c["title"].as_str().unwrap_or("");
    let dn = c["dn"].as_str().filter(|d| !d.is_empty());
    match c["op"].as_str().expect("campo op") {
        "specificity" => episode_parse_specificity(&parse_title_season_episode(title)).to_string(),
        "choose" => parse_text(&choose_episode_parse(title, dn)),
        "route" => target_text(route_work_location(request(&c), title, dn)),
        "fits" => bit(release_fits_request(request(&c), title, dn)),
        "targets" => {
            let list = release_work_targets(title, request(&c), dn, &year_text(&c["year"]));
            if list.is_empty() {
                "(none)".to_string()
            } else {
                list.into_iter()
                    .map(target_text)
                    .collect::<Vec<_>>()
                    .join(" ")
            }
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
    assert_eq!(m.output.path, "rust/golden/release-work.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-release-work.json");
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
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}
