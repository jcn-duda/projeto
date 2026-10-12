//! Integridade e paridade do golden de relevância crua (`filterRelevantRaw` do
//! `src/utils/release-filters.ts`, com o corte de `filterRelevantRawForYear`).
//!
//! O `input` de cada caso é um JSON tipado (`items`, `names`, `year`, `altYear`,
//! `season`, `episode`, `multiWork`, `homeReleaseAt`, e o ambiente que o TS lê em
//! tempo de chamada: `now`, `preHomeCut`, `preHomeMarginMs`). O JSON vira
//! `RelevanceItem`/`RelevanceQuery`/`RelevanceSettings` e a saída canônica
//! `{"kept":[…],"rejected":[[i,"motivo"]]}` é comparada caso a caso com o que o
//! oráculo do dist mediu. O porte não replica lógica do Node: só reproduz a
//! saída commitada no golden.
//!
//! `titlePrecisionTailCut` fica no default (true) em todos os casos: o TS o lê
//! uma vez, ao carregar o módulo (`TITLE_PRECISION_MIN`), então o oráculo não
//! consegue trocá-lo por caso.

mod common;

use std::collections::HashSet;

use adom_core::{
    filter_relevant_raw, filter_relevant_raw_for_year, RelevanceItem, RelevanceOutcome,
    RelevanceQuery, RelevanceRejectReason, RelevanceSettings, MANIFEST_FORMAT,
};
use serde_json::{json, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/release-filters.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/release-filters.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-release-filters.json");

const REGISTRY_MATCH: &str = "release-filters/filterRelevantRaw";

/// Campos de string opcionais do JSON; qualquer outra coisa vira ausente.
fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// `String(x ?? '')` do TS: `null` vira `""`, número vira decimal, string fica.
fn year_text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        outro => panic!("ano com tipo inesperado: {outro}"),
    }
}

fn item_of(v: &Value) -> RelevanceItem {
    RelevanceItem {
        title: opt_str(&v["title"]),
        title_pascal: opt_str(&v["Title"]),
        magnet: opt_str(&v["magnet"]),
        magnet_uri: opt_str(&v["MagnetUri"]),
        guid: opt_str(&v["Guid"]),
        is_br: v["isBr"].as_bool().unwrap_or(false),
    }
}

/// Dono dos dados de um caso; a `RelevanceQuery` empresta deste struct.
struct Owned {
    items: Vec<RelevanceItem>,
    names: Vec<String>,
    year: String,
    alt_year: Option<String>,
    is_series: bool,
    season: Option<i64>,
    episode: Option<i64>,
    multi_work_root: Option<String>,
    home_release_at: Option<i64>,
    settings: RelevanceSettings,
}

fn owned_of(input: &str) -> Owned {
    let req: Value = serde_json::from_str(input).expect("input do caso é JSON");
    let names = req["names"]
        .as_array()
        .expect("names: array")
        .iter()
        .map(|n| n.as_str().expect("nome é string").to_string())
        .collect();
    let alt_year = match &req["altYear"] {
        Value::Null => None,
        outro => Some(year_text(outro)),
    };
    let multi_work_root = opt_str(&req["multiWork"]["root"]).filter(|r| !r.is_empty());
    Owned {
        items: req["items"]
            .as_array()
            .expect("items: array")
            .iter()
            .map(item_of)
            .collect(),
        names,
        year: year_text(&req["year"]),
        alt_year,
        is_series: req["isSeries"].as_bool().expect("isSeries: bool"),
        season: req["season"].as_i64(),
        episode: req["episode"].as_i64(),
        multi_work_root,
        home_release_at: req["homeReleaseAt"].as_i64(),
        settings: RelevanceSettings {
            now_ms: req["now"].as_i64().expect("now: inteiro"),
            pre_home_release_cut: req["preHomeCut"].as_bool().expect("preHomeCut: bool"),
            pre_home_release_margin_ms: req["preHomeMarginMs"]
                .as_i64()
                .expect("preHomeMarginMs: inteiro"),
            title_precision_tail_cut: true,
        },
    }
}

fn query_of(o: &Owned) -> RelevanceQuery<'_> {
    RelevanceQuery {
        names: &o.names,
        year: &o.year,
        alt_year: o.alt_year.as_deref(),
        is_series: o.is_series,
        season: o.season,
        episode: o.episode,
        multi_work_root: o.multi_work_root.as_deref(),
        home_release_at: o.home_release_at,
    }
}

/// Saída canônica, idêntica ao `JSON.stringify` do oráculo.
fn canonical(outcome: &RelevanceOutcome) -> String {
    let rejected: Vec<Value> = outcome
        .rejected
        .iter()
        .map(|(i, reason)| json!([i, reason.as_str()]))
        .collect();
    json!({ "kept": outcome.kept, "rejected": rejected }).to_string()
}

/// Roda `filterRelevantRaw` do porte e devolve a saída canônica.
fn render(input: &str) -> String {
    let o = owned_of(input);
    canonical(&filter_relevant_raw(&o.items, &query_of(&o), &o.settings))
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/release-filters.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-release-filters.json");
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
    assert!(
        cases.len() >= 150,
        "golden precisa ter pelo menos 150 casos"
    );
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

/// `filterRelevantRawForYear` não é exportada pelo TS; o golden mede o caminho
/// `filterRelevantRaw` sem ano dual distinto, que é exatamente o corpo dela.
/// Aqui o porte de `filter_relevant_raw_for_year` tem de dar o mesmo golden
/// nesses casos (altYear ausente, nulo ou igual ao ano de catálogo).
#[test]
fn filter_relevant_raw_for_year_bate_com_o_golden_sem_ano_dual() {
    let mut conferidos = 0;
    for case in parse_cases(JSONL_BYTES) {
        let o = owned_of(&case.input);
        let dual_distinto = o
            .alt_year
            .as_deref()
            .is_some_and(|alt| alt != o.year.as_str());
        if dual_distinto {
            continue;
        }
        let obtido = canonical(&filter_relevant_raw_for_year(
            &o.items,
            &query_of(&o),
            &o.settings,
        ));
        assert_eq!(
            obtido, case.expected,
            "ForYear divergiu no caso {}",
            case.id
        );
        conferidos += 1;
    }
    assert!(conferidos > 100, "poucos casos sem ano dual: {conferidos}");
}

/// O texto do motivo é o literal do TS: o golden e o consumidor dependem disso.
#[test]
fn motivos_tem_a_grafia_do_ts() {
    let esperados = [
        (RelevanceRejectReason::Title, "title"),
        (RelevanceRejectReason::MagnetYear, "magnet-year"),
        (RelevanceRejectReason::NamedSequel, "named-sequel"),
        (RelevanceRejectReason::Identity, "identity"),
        (RelevanceRejectReason::Episode, "episode"),
        (RelevanceRejectReason::SeriesWork, "series-work"),
        (RelevanceRejectReason::MovieIsSeries, "movie-is-series"),
        (RelevanceRejectReason::SeriesIsMovie, "series-is-movie"),
        (RelevanceRejectReason::PreHomeRelease, "pre-home-release"),
        (RelevanceRejectReason::NonFeature, "non-feature"),
    ];
    for (reason, text) in esperados {
        assert_eq!(reason.as_str(), text);
    }
}

/// Negativos diretos: sem nomes nada sai; item sem título é rejeitado por `title`.
#[test]
fn entradas_de_borda_sem_depender_do_corpus() {
    let settings = RelevanceSettings {
        now_ms: 0,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: 0,
        title_precision_tail_cut: true,
    };
    let sem_nomes: Vec<String> = Vec::new();
    let query = RelevanceQuery {
        names: &sem_nomes,
        year: "2010",
        alt_year: None,
        is_series: false,
        season: None,
        episode: None,
        multi_work_root: None,
        home_release_at: None,
    };
    let itens = vec![RelevanceItem::default()];
    assert_eq!(
        canonical(&filter_relevant_raw(&itens, &query, &settings)),
        r#"{"kept":[0],"rejected":[]}"#
    );

    let nomes = vec!["Inception".to_string()];
    let query = RelevanceQuery {
        names: &nomes,
        ..query
    };
    assert_eq!(
        canonical(&filter_relevant_raw(&itens, &query, &settings)),
        r#"{"kept":[],"rejected":[[0,"title"]]}"#
    );
}
