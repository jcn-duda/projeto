//! Normalizador: idempotência, insensibilidade a ordem, sensibilidade a campos
//! e tolerância a casos parciais.

mod common;

use adom_parity::{normalize_body, Diff, NormalizeOptions, NormalizedResponse};
use serde_json::{json, Value};

fn body_of(case_id: &str) -> Value {
    common::corpus()
        .case(case_id)
        .unwrap_or_else(|| panic!("caso {case_id}"))
        .response
        .body
        .clone()
        .unwrap_or_else(|| panic!("caso {case_id} sem body"))
}

fn normalize(body: &Value) -> NormalizedResponse {
    normalize_body(body, &NormalizeOptions::default()).expect("normalização")
}

#[test]
fn normalizador_e_idempotente_no_corpus_real() {
    let body = body_of("movie-matrix");
    let once = normalize(&body);
    let twice = normalize(&once.to_value());
    assert_eq!(once, twice);
    assert_eq!(once.fingerprint(), twice.fingerprint());
}

#[test]
fn ordem_dos_streams_nao_muda_o_resultado() {
    let body = body_of("series-breaking-bad-s05-pack");
    let mut reversed = body.clone();
    let mut items = body["streams"].as_array().expect("streams").clone();
    items.reverse();
    reversed["streams"] = Value::Array(items);

    let expected = normalize(&body);
    let actual = normalize(&reversed);
    assert_eq!(expected, actual);
    assert_eq!(Diff::compare(&expected, &actual).len(), 0);
}

#[test]
fn campo_alterado_e_detectado_com_indice() {
    let body = body_of("movie-matrix");
    let expected = normalize(&body);
    let mut altered = body.clone();
    altered["streams"][0]["title"] = json!("TÍTULO ALTERADO");
    let actual = normalize(&altered);
    let diff = Diff::compare(&expected, &actual);
    assert!(!diff.is_empty());
    assert!(
        diff.entries
            .iter()
            .any(|entry| entry.field.ends_with(".title")),
        "{diff}"
    );
    assert!(diff.entries.iter().any(|entry| entry.index.is_some()));
    assert!(diff.to_string().contains("TÍTULO ALTERADO"), "{diff}");
}

#[test]
fn cache_max_age_e_contrato_por_default() {
    let body = body_of("movie-matrix");
    let expected = normalize(&body);
    let mut altered = body.clone();
    // Valor SEMPRE diferente do capturado: a lista completa sai com 900, e a
    // recaptura não pode decidir se o teste enxerga a diferença.
    let changed = if body["cacheMaxAge"] == json!(900) {
        60
    } else {
        900
    };
    altered["cacheMaxAge"] = json!(changed);
    let actual = normalize(&altered);
    let diff = Diff::compare(&expected, &actual);
    assert_eq!(diff.len(), 1, "{diff}");
    assert_eq!(diff.entries[0].field, "cacheMaxAge");

    let masked = NormalizeOptions::default().masking_cache_max_age(true);
    let expected = normalize_body(&body, &masked).expect("normaliza");
    let actual = normalize_body(&altered, &masked).expect("normaliza");
    assert!(Diff::compare(&expected, &actual).is_empty());
}

#[test]
fn stream_removido_aparece_como_ausente() {
    let body = body_of("movie-matrix");
    let expected = normalize(&body);
    let mut altered = body.clone();
    let items = altered["streams"].as_array_mut().expect("streams");
    items.pop();
    let actual = normalize(&altered);
    let diff = Diff::compare(&expected, &actual);
    assert!(diff
        .entries
        .iter()
        .any(|entry| entry.field == "streams.length"));
    assert!(diff.entries.iter().any(|entry| entry.actual.is_null()));
}

#[test]
fn campos_volateis_e_internos_saem() {
    let body = json!({
        "streams": [{
            "title": "A",
            "_br": true,
            "_seeders": 10,
            "trace": "x",
            "elapsedMs": 12,
            "infoHash": "aa"
        }],
        "cacheMaxAge": 0,
        "metrics": {"x": 1},
        "_internal": "y"
    });
    let normalized = normalize(&body);
    let stream = &normalized.streams[0];
    assert_eq!(stream.get("_br"), None);
    assert_eq!(stream.get("_seeders"), None);
    assert_eq!(stream.get("trace"), None);
    assert_eq!(stream.get("elapsedMs"), None);
    assert_eq!(stream.get("infoHash"), Some(&json!("aa")));
    assert_eq!(normalized.fields.get("metrics"), None);
    assert_eq!(normalized.fields.get("_internal"), None);
}

#[test]
fn mascara_origem_config_e_sig_juntas() {
    let body = json!({
        "streams": [{
            "url": "http://127.0.0.1:7000/e30/resolve/aa?w=x&sig=dead&s=1",
            "externalUrl": "http://127.0.0.1:7000/e30/configure"
        }],
        "cacheMaxAge": 0
    });
    let options = NormalizeOptions::default()
        .with_base_url("http://127.0.0.1:7000")
        .with_config_segment("e30");
    let normalized = normalize_body(&body, &options).expect("normaliza");
    let stream = &normalized.streams[0];
    assert_eq!(
        stream.string("url"),
        Some("{{base}}/{{config}}/resolve/aa?w=x&sig={{sig}}&s=1")
    );
    assert_eq!(
        stream.string("externalUrl"),
        Some("{{base}}/{{config}}/configure")
    );
}

#[test]
fn caso_parcial_nao_entra_em_panic() {
    let options = NormalizeOptions::default();
    assert!(normalize_body(&Value::Null, &options).is_err());
    assert!(normalize_body(&json!({"streams": {}}), &options).is_err());
    assert!(normalize_body(&json!({"streams": [null]}), &options).is_err());

    let empty = normalize_body(&json!({}), &options).expect("{} é tolerado");
    assert_eq!(empty.stream_count(), 0);
    assert_eq!(empty.cache_max_age(), None);

    let minimal = normalize_body(&json!({"streams": [{}]}), &options).expect("item vazio");
    assert_eq!(minimal.stream_count(), 1);
    assert_eq!(minimal.streams[0].identity(), "empty");
    assert!(minimal.streams[0]
        .to_value()
        .as_object()
        .unwrap()
        .is_empty());
}

#[test]
fn item_sem_identidade_nao_colide_quando_ha_duplicata() {
    let body = json!({"streams": [{}, {}], "cacheMaxAge": 0});
    let normalized = normalize(&body);
    let changed = json!({"streams": [{}, {}, {}], "cacheMaxAge": 0});
    let actual = normalize(&changed);
    let diff = Diff::compare(&normalized, &actual);
    // Duas identidades "empty" casam por posição; a terceira é extra.
    assert!(diff
        .entries
        .iter()
        .any(|entry| entry.field == "streams.length"));
    assert!(diff.entries.iter().any(|entry| entry.expected.is_null()));
}
