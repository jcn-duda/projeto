//! Carga do corpus real e tolerância a esquema parcial/temperado.

mod common;

use std::collections::BTreeSet;

use adom_parity::{normalize_body, Corpus, DiagnosticLevel, NormalizeOptions, FORMAT};

#[test]
fn corpus_real_carrega_51_casos_e_sha256_confere() {
    let corpus = Corpus::load(common::corpus_root()).expect("corpus real deve carregar");
    let errors = common::diagnostics_text(
        corpus
            .diagnostics
            .iter()
            .filter(|d| d.level == DiagnosticLevel::Error),
    );
    assert!(!corpus.has_errors(), "erros no corpus:\n{errors}");
    assert_eq!(corpus.manifest.format, FORMAT);
    assert_eq!(corpus.stats.manifest_cases, 51);
    assert_eq!(corpus.stats.loaded_cases, 51);
    assert_eq!(corpus.cases.len(), 51);
    assert_eq!(corpus.stats.movies, 27);
    assert_eq!(corpus.stats.series, 24);
    assert_eq!(corpus.stats.other_types, 0);
    assert_eq!(corpus.stats.json_bodies, 51);
    assert_eq!(corpus.stats.raw_bodies, 0);
    assert_eq!(corpus.stats.empty_lists, 1);
    assert_eq!(corpus.stats.notice_cases, 2);
    assert_eq!(corpus.stats.p2p_cases, 47);
    assert_eq!(corpus.stats.debrid_cases, 1);
    assert_eq!(corpus.stats.stream_items, 384);
    assert_eq!(corpus.stats.max_streams, 11);
    assert_eq!(corpus.stats.labels_missing, 0);
    // O corpus real NÃO tem trace/meta/raw/debrid por etapa. Este assert é o
    // tripwire: quando o gerador passar a gravá-los, atualize a documentação e
    // o runner para consumir as entradas novas.
    // O corpus recapturado agora tem as fixtures internas (`inputs/`) por caso;
    // o tripwire dispara e o runner consome as entradas novas.
    assert_eq!(corpus.stats.step_files, 51);
    assert!(!corpus.stats.step_file_names.is_empty());
    let expected_fields: BTreeSet<String> = [
        "behaviorHints",
        "externalUrl",
        "infoHash",
        "name",
        "size",
        "sources",
        "title",
        "url",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert_eq!(corpus.stats.stream_fields, expected_fields);
    assert_eq!(
        corpus.stats.request_headers,
        BTreeSet::from(["user-agent".to_string()])
    );
    assert_eq!(corpus.stats.file_names.get("request.json"), Some(&51));
    assert_eq!(corpus.stats.file_names.get("response.json"), Some(&51));
}

#[test]
fn todos_os_casos_normalizam_sem_panic() {
    let corpus = Corpus::load(common::corpus_root()).expect("corpus real");
    for case in &corpus.cases {
        let Some(body) = &case.response.body else {
            continue;
        };
        let normalized = normalize_body(body, &NormalizeOptions::default())
            .unwrap_or_else(|error| panic!("{}: {error}", case.meta.id));
        let expected_streams = body
            .get("streams")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        assert_eq!(
            normalized.stream_count(),
            expected_streams,
            "contagem no caso {}",
            case.meta.id
        );
        assert!(
            normalized.cache_max_age().is_some(),
            "cacheMaxAge em {}",
            case.meta.id
        );
    }
}

#[test]
fn manifest_ausente_nao_entra_em_panic() {
    let dir = common::TempDir::new("manifest-vazio");
    dir.write("manifest.json", "{}");
    let corpus = Corpus::load(dir.path()).expect("manifest vazio deve carregar tolerante");
    assert_eq!(corpus.stats.manifest_cases, 0);
    assert_eq!(corpus.cases.len(), 0);
    assert!(
        corpus.has_errors(),
        "formato ausente e zero casos são erro de contrato"
    );
    assert!(corpus
        .diagnostics
        .iter()
        .any(|d| d.message.contains("manifest.format")));
}

#[test]
fn caso_parcial_carrega_com_diagnostico_e_nao_quebra() {
    let dir = common::TempDir::new("caso-parcial");
    dir.write(
        "manifest.json",
        r#"{
          "format": "adom-stream-e2e/1",
          "cases": [
            { "id": "partial", "dir": "cases/partial" }
          ]
        }"#,
    );
    dir.write("cases/partial/request.json", "{}");
    dir.write(
        "cases/partial/response.json",
        r#"{ "body": { "streams": [] } }"#,
    );
    let corpus = Corpus::load(dir.path()).expect("caso parcial deve carregar");
    assert_eq!(corpus.cases.len(), 1);
    assert_eq!(corpus.cases[0].meta.id, "partial");
    assert_eq!(
        corpus.cases[0].response.body.as_ref().unwrap()["streams"],
        serde_json::json!([])
    );
    // O caso é carregado para diff; o diagnóstico aponta o contrato faltando.
    assert!(corpus.has_errors(), "path sem /stream/ é erro");
    assert!(corpus
        .diagnostics
        .iter()
        .any(|d| d.message.contains("request.path")));
}

#[test]
fn sha256_divergente_reprova_sem_panic() {
    let dir = common::TempDir::new("sha-temperado");
    dir.write(
        "manifest.json",
        r#"{
          "format": "adom-stream-e2e/1",
          "cases": [
            {
              "id": "tampered",
              "type": "movie",
              "stream_id": "tt1",
              "dir": "cases/tampered",
              "status": 200,
              "cacheMaxAge": 0,
              "files": {
                "request.json": "0000000000000000000000000000000000000000000000000000000000000000"
              }
            }
          ]
        }"#,
    );
    dir.write(
        "cases/tampered/request.json",
        r#"{"method":"GET","path":"/{{config}}/stream/movie/tt1.json","headers":{}}"#,
    );
    dir.write(
        "cases/tampered/response.json",
        r#"{"status":200,"cacheMaxAge":0,"body":{"streams":[],"cacheMaxAge":0}}"#,
    );
    let corpus = Corpus::load(dir.path()).expect("sha divergente não aborta a carga");
    assert_eq!(corpus.cases.len(), 1);
    assert!(corpus.has_errors());
    assert!(
        corpus
            .diagnostics
            .iter()
            .any(|d| d.message.contains("sha256") && d.message.contains("request.json")),
        "{:?}",
        corpus.diagnostics
    );
}

#[test]
fn corpus_sem_casos_nao_panica() {
    let dir = common::TempDir::new("sem-casos");
    dir.write("manifest.json", r#"{"format":"adom-stream-e2e/1"}"#);
    let corpus = Corpus::load(dir.path()).expect("manifest sem cases carrega");
    assert_eq!(corpus.cases.len(), 0);
    assert!(corpus.has_errors());
}
