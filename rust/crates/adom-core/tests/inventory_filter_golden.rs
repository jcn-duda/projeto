//! Integridade e paridade do golden de `filterInventoryRelevant`
//! (`src/utils/release-filters.ts`): o caminho estrito de `filterRelevantRaw`
//! mais o resgate de pack multiobra.
//!
//! O `input` é `{"items":[...],"options":{...}}`. A saída canônica é
//! `{"kept":[índices],"rejected":[[índice,"motivo"],...]}`, medida pelo oráculo
//! do dist. O relógio do porte é fixo: as datas de estreia do corpus (2000 e
//! 2090) estão longe de qualquer "agora", então o veredito não depende dele.

mod common;

use adom_core::{
    filter_inventory_relevant, RelevanceItem, RelevanceQuery, RelevanceSettings, MANIFEST_FORMAT,
};
use serde_json::{json, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/inventory-filter.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/inventory-filter.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-inventory-filter.json");

const REGISTRY_MATCH: &str = "inventory-filter/filterInventoryRelevant";
/// Relógio injetado (o TS usa `Date.now()`). Qualquer valor real serve.
const NOW_MS: i64 = 1_790_000_000_000;
const PRE_HOME_MARGIN_MS: i64 = 48 * 3600 * 1000;

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

fn item_of(v: &Value) -> RelevanceItem {
    RelevanceItem {
        title: text(&v["title"]),
        title_pascal: text(&v["Title"]),
        magnet: text(&v["magnet"]),
        magnet_uri: text(&v["MagnetUri"]),
        guid: text(&v["Guid"]),
        is_br: v["isBr"].as_bool().unwrap_or(false),
    }
}

/// Entrada JSON → saída canônica, com o caminho de `filterInventoryRelevant`.
fn render(input: &str) -> String {
    let req: Value = serde_json::from_str(input).expect("input do caso é JSON");
    let o = &req["options"];
    let names: Vec<String> = o["names"]
        .as_array()
        .expect("names é array")
        .iter()
        .map(|n| n.as_str().expect("nome é string").to_string())
        .collect();
    let items: Vec<RelevanceItem> = req["items"]
        .as_array()
        .expect("items é array")
        .iter()
        .map(item_of)
        .collect();
    let year = o["year"].as_str().expect("year é string");
    let alt_year = o["altYear"].as_str();
    let root = o["multiWork"]["root"].as_str();
    let query = RelevanceQuery {
        names: &names,
        year,
        alt_year,
        is_series: o["isSeries"].as_bool().unwrap_or(false),
        season: o["season"].as_i64(),
        episode: o["episode"].as_i64(),
        multi_work_root: root,
        home_release_at: o["homeReleaseAt"].as_i64(),
    };
    let settings = RelevanceSettings {
        now_ms: NOW_MS,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: PRE_HOME_MARGIN_MS,
        title_precision_tail_cut: true,
    };
    let outcome = filter_inventory_relevant(&items, &query, &settings);
    let rejected: Vec<Value> = outcome
        .rejected
        .iter()
        .map(|(i, r)| json!([i, r.as_str()]))
        .collect();
    json!({ "kept": outcome.kept, "rejected": rejected }).to_string()
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/inventory-filter.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-inventory-filter.json");
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
    let mut ids = std::collections::HashSet::new();
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

/// Sem nomes não há relevância: a lista sai vazia e nada é rejeitado.
#[test]
fn sem_nomes_nada_passa_nem_rejeita() {
    let names: Vec<String> = Vec::new();
    let items = vec![RelevanceItem {
        title: Some("Inception 2010 1080p".into()),
        ..Default::default()
    }];
    let query = RelevanceQuery {
        names: &names,
        year: "2010",
        alt_year: None,
        is_series: false,
        season: None,
        episode: None,
        multi_work_root: None,
        home_release_at: None,
    };
    let settings = RelevanceSettings {
        now_ms: NOW_MS,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: PRE_HOME_MARGIN_MS,
        title_precision_tail_cut: true,
    };
    let out = filter_inventory_relevant(&items, &query, &settings);
    assert!(out.kept.is_empty());
    assert!(out.rejected.is_empty());
}
