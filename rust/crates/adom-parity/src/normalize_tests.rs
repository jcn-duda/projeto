use super::*;
use serde_json::json;

#[test]
fn mascara_sig_preserva_os_outros_parametros() {
    let options = NormalizeOptions::default();
    let url = "http://x/{{config}}/resolve/abc?w=%7B%22a%22%3A1%7D&sig=deadbeef&s=2";
    assert_eq!(
        mask_url(url, &options),
        "{{base}}/{{config}}/resolve/abc?w=%7B%22a%22%3A1%7D&sig={{sig}}&s=2"
    );
}

#[test]
fn mascaras_sao_idempotentes() {
    let options = NormalizeOptions::default()
        .with_base_url("http://127.0.0.1:7000")
        .with_config_segment("eyJwIjoiamFja2V0dCJ9");
    let once = mask_url(
        "http://127.0.0.1:7000/eyJwIjoiamFja2V0dCJ9/resolve/abc?sig=deadbeef",
        &options,
    );
    assert_eq!(once, "{{base}}/{{config}}/resolve/abc?sig={{sig}}");
    assert_eq!(mask_url(&once, &options), once);
}

#[test]
fn origem_automatica_nao_toca_tracker() {
    let options = NormalizeOptions::default();
    let normalized = normalize_body(
        &json!({
            "streams": [{
                "infoHash": "ABC",
                "url": "http://host:7000/ct/resolve/abc?sig=1",
                "externalUrl": "https://outro/configure",
                "sources": ["tracker:udp://tracker.example:1337/announce"]
            }],
            "cacheMaxAge": 0
        }),
        &options,
    )
    .expect("corpo válido");
    let stream = &normalized.streams[0];
    assert_eq!(
        stream.string("url"),
        Some("{{base}}/ct/resolve/abc?sig={{sig}}")
    );
    assert_eq!(stream.string("externalUrl"), Some("{{base}}/configure"));
    // `sources` é dado público do torrent: a origem NÃO vira `{{base}}`.
    assert_eq!(
        stream
            .get("sources")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(1)
    );
    assert!(stream
        .get("sources")
        .and_then(Value::as_array)
        .and_then(|items| items[0].as_str())
        .is_some_and(|s| s.starts_with("tracker:udp://tracker.example")));
}

#[test]
fn body_sem_streams_vira_lista_vazia_sem_panic() {
    let normalized = normalize_body(&json!({"cacheMaxAge": 0}), &NormalizeOptions::default())
        .expect("{} é tolerado");
    assert_eq!(normalized.stream_count(), 0);
    assert_eq!(normalized.cache_max_age(), Some(&json!(0)));
}

#[test]
fn streams_que_nao_e_array_vira_erro_de_contrato() {
    let error = normalize_body(&json!({"streams": "x"}), &NormalizeOptions::default())
        .expect_err("string em streams deve ser erro");
    assert!(error.message.contains("não é array"), "{error}");
}
