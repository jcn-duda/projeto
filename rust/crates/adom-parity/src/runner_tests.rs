use super::*;
use crate::corpus::{CaseMeta, CaseRequest, RecordedResponse};
use serde_json::json;

fn fake_case(id: &str, body: Value) -> Case {
    Case {
        meta: CaseMeta {
            id: id.to_string(),
            ..CaseMeta::default()
        },
        request: CaseRequest {
            method: "GET".to_string(),
            path: "/{{config}}/stream/movie/tt1.json".to_string(),
            ..CaseRequest::default()
        },
        response: RecordedResponse {
            body: Some(body),
            ..RecordedResponse::default()
        },
    }
}

#[test]
fn replay_de_um_caso_bate() {
    let case = fake_case(
        "x",
        json!({"streams": [{"infoHash": "aa", "title": "A"}], "cacheMaxAge": 0}),
    );
    let report = run_corpus(
        &Corpus {
            root: Default::default(),
            manifest: Default::default(),
            cases: vec![case],
            diagnostics: Vec::new(),
            stats: Default::default(),
        },
        &ReplaySource,
        &NormalizeOptions::default(),
    );
    assert!(report.is_perfect(), "{report}");
    assert_eq!(report.compared(), 1);
}

#[test]
fn fonte_com_titulo_diferente_diverge_sem_panic() {
    let case = fake_case(
        "x",
        json!({"streams": [{"infoHash": "aa", "title": "A"}], "cacheMaxAge": 0}),
    );
    let source =
        |_case: &Case| Ok(json!({"streams": [{"infoHash": "aa", "title": "B"}], "cacheMaxAge": 0}));
    let report = run_corpus(
        &Corpus {
            root: Default::default(),
            manifest: Default::default(),
            cases: vec![case],
            diagnostics: Vec::new(),
            stats: Default::default(),
        },
        &source,
        &NormalizeOptions::default(),
    );
    assert_eq!(report.diverged(), 1, "{report}");
    assert!(report.to_string().contains("streams[0].title"), "{report}");
}

#[test]
fn body_raw_e_pulado() {
    let mut case = fake_case("x", Value::Null);
    case.response.body = None;
    case.response.body_raw = Some("<html>".to_string());
    let report = run_corpus(
        &Corpus {
            root: Default::default(),
            manifest: Default::default(),
            cases: vec![case],
            diagnostics: Vec::new(),
            stats: Default::default(),
        },
        &ReplaySource,
        &NormalizeOptions::default(),
    );
    assert_eq!(report.skipped(), 1, "{report}");
    assert!(!report.is_perfect());
}
