//! Remontagem via `Orchestrator::handle` com stubs — contrato §9.

mod common;

use std::collections::BTreeMap;

use adom_parity::{
    run_corpus, Case, CaseFixtures, CaseMeta, CaseRequest, CaseStatus, Corpus,
    FixtureOrchestratorSource, NormalizeOptions, OrchestratorSource, ProduceOutcome,
    RecordedResponse, SourceOptions, StreamSource, DEFAULT_CONFIG_SEGMENT, DEFAULT_ORIGIN,
};
use adom_search::orchestrator::SearchMeta;
use adom_search::RawItem;
use serde_json::{json, Value};

const HASH: &str = "0123456789abcdef0123456789abcdef01234567";

fn stub_meta() -> SearchMeta {
    SearchMeta {
        imdb_id: "tt0133093".into(),
        season: None,
        episode: None,
        name: "Filme Teste".into(),
        names: vec!["Filme Teste".into()],
        year: json!("2024"),
        alt_year: None,
        released: None,
        first_aired: None,
        episode_aired_at_ms: None,
        home_release_at: None,
        query: "Filme Teste 2024".into(),
        pt_query: None,
        pt_title: None,
        titles: None,
        sweep_query: None,
        original_query: None,
        multi_work_root: None,
        multi_work_query: None,
        episode_counts: Vec::new(),
        is_demo: false,
    }
}

fn stub_raw() -> RawItem {
    RawItem {
        title: Some("Filme Teste 2024 1080p WEB-DL x264".into()),
        info_hash: Some(HASH.into()),
        seeders: Some(20.0),
        indexer: Some("bludv".into()),
        ..RawItem::default()
    }
}

fn stub_case(body: Option<Value>) -> Case {
    let mut headers = BTreeMap::new();
    headers.insert("user-agent".into(), "adom-stream-e2e/1".into());
    Case {
        meta: CaseMeta {
            id: "stub-filme-teste".into(),
            kind: "movie".into(),
            stream_id: "tt0133093".into(),
            dir: "cases/stub-filme-teste".into(),
            ..CaseMeta::default()
        },
        request: CaseRequest {
            method: "GET".into(),
            path: "/{{config}}/stream/movie/tt0133093.json".into(),
            headers,
            ..CaseRequest::default()
        },
        response: RecordedResponse {
            body,
            ..RecordedResponse::default()
        },
    }
}

fn normalize_opts() -> NormalizeOptions {
    NormalizeOptions::default()
        .with_config_segment(DEFAULT_CONFIG_SEGMENT)
        .with_base_url(DEFAULT_ORIGIN)
}

/// Remonta com stubs, embaralha ordem no "Node" gravado e exige Match após §9.
#[test]
fn orchestrator_source_remonta_stubs_e_bate_identidades_mascaradas() {
    let fixtures = CaseFixtures {
        meta: stub_meta(),
        raw: vec![stub_raw()],
        cached_hashes: vec![HASH.to_string()],
    };
    let source = OrchestratorSource::from_fixtures(fixtures).expect("fonte com stubs");

    let probe = stub_case(None);
    let rust_body = match source.produce(&probe).expect("produce") {
        ProduceOutcome::Body(body) => body,
        ProduceOutcome::Skip { reason } => panic!("não deveria pular: {reason}"),
    };
    let streams = rust_body["streams"]
        .as_array()
        .expect("streams array")
        .clone();
    assert_eq!(streams.len(), 1, "stub em cache deve virar 1 stream");
    let url = streams[0]["url"].as_str().expect("url de play");
    assert!(
        url.contains("/resolve/") && url.contains(HASH),
        "url sem resolve/hash: {url}"
    );
    assert!(url.starts_with(DEFAULT_ORIGIN), "host na resposta: {url}");

    // Lado "Node": mesma identidade, ordem invertida (lista de 1 é no-op;
    // espelhamos o corpo e forçamos o normalizador a mascarar host/sig/config).
    let node_body = json!({
        "streams": streams,
        "cacheMaxAge": rust_body["cacheMaxAge"],
    });
    let case = stub_case(Some(node_body));
    let report = run_corpus(
        &Corpus {
            root: Default::default(),
            manifest: Default::default(),
            cases: vec![case],
            diagnostics: Vec::new(),
            stats: Default::default(),
        },
        &source as &dyn StreamSource,
        &normalize_opts(),
    );
    assert_eq!(report.compared(), 1, "{report}");
    assert_eq!(report.matched(), 1, "{report}");
    assert_eq!(report.diverged(), 0, "{report}");
    assert!(matches!(
        report.cases[0].status,
        CaseStatus::Match { streams: 1, .. }
    ));
}

/// Corpus real ainda não grava meta/raw — 51 skips, zero Match falso.
#[test]
fn corpus_sem_fixtures_pula_todos_sem_falso_verde() {
    let corpus = common::corpus();
    let source =
        FixtureOrchestratorSource::for_corpus_with(common::corpus_root(), SourceOptions::default())
            .expect("fonte fixture");
    let report = run_corpus(corpus, &source as &dyn StreamSource, &normalize_opts());
    assert_eq!(report.skipped(), 51, "{report}");
    assert_eq!(report.matched(), 0, "{report}");
    assert_eq!(report.diverged(), 0, "{report}");
    assert_eq!(report.compared(), 0, "{report}");
    assert_eq!(report.source_errors(), 0, "{report}");
    let sample = report.to_string();
    assert!(sample.contains("sem meta.json/raw.json"), "{sample}");
}

/// Diretório de caso com fixtures: FixtureOrchestratorSource remonta e bate.
#[test]
fn fixture_dir_remonta_e_compara_apos_mascara() {
    let dir = common::TempDir::new("fixture-orch");
    let case_rel = "cases/stub-filme-teste";
    dir.write(
        &format!("{case_rel}/meta.json"),
        r#"{
            "imdb_id": "tt0133093",
            "name": "Filme Teste",
            "names": ["Filme Teste"],
            "year": "2024",
            "query": "Filme Teste 2024"
        }"#,
    );
    dir.write(
        &format!("{case_rel}/raw.json"),
        &format!(
            r#"[{{
                "title": "Filme Teste 2024 1080p WEB-DL x264",
                "infoHash": "{HASH}",
                "seeders": 20,
                "indexer": "bludv"
            }}]"#
        ),
    );
    dir.write(
        &format!("{case_rel}/debrid.json"),
        &format!(r#"{{"cached":["{HASH}"]}}"#),
    );

    let source = FixtureOrchestratorSource::for_corpus(dir.path()).expect("fonte");
    let probe = stub_case(None);
    let rust_body = match source.produce(&probe).expect("produce") {
        ProduceOutcome::Body(body) => body,
        ProduceOutcome::Skip { reason } => panic!("fixtures presentes: {reason}"),
    };

    let case = stub_case(Some(rust_body.clone()));
    // Embaralha ordem de chaves no JSON gravado (normalizador §9 reordena).
    let scrambled =
        serde_json::from_str::<Value>(&serde_json::to_string(&rust_body).expect("serialize"))
            .expect("reparse");
    let case = Case {
        response: RecordedResponse {
            body: Some(scrambled),
            ..case.response
        },
        ..case
    };

    let report = run_corpus(
        &Corpus {
            root: dir.path().to_path_buf(),
            manifest: Default::default(),
            cases: vec![case],
            diagnostics: Vec::new(),
            stats: Default::default(),
        },
        &source as &dyn StreamSource,
        &normalize_opts(),
    );
    assert_eq!(report.matched(), 1, "{report}");
    assert_eq!(report.diverged(), 0, "{report}");
}
