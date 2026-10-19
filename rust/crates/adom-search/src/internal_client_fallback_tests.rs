use super::*;

#[tokio::test]
async fn fallback_leva_deadline_e_parseia_config() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let deadline = now_ms() + 5_000;
    let res = client(&base)
        .fallback(&fallback_request(Some(deadline)))
        .await
        .unwrap();
    let body = seen.bodies.lock().await.first().cloned().unwrap();
    assert_eq!(body["encoded"], json!(ENCODED));
    assert_eq!(body["type"], json!("movie"));
    assert_eq!(body["deadline_at"], json!(deadline));
    assert!(res.ok && res.enabled && res.fallback_enabled);
    assert_eq!(res.per_indexer_max, 40);
    assert_eq!(res.global_max, 40);
}

#[tokio::test]
async fn fallback_deadline_curto_corta_a_rede() {
    let seen = Arc::new(Seen::default());
    *seen.delay_ms.lock().await = 2_000;
    let base = serve(seen.clone()).await;
    let started = Instant::now();
    let err = client(&base)
        .fallback(&fallback_request(Some(now_ms() + 100)))
        .await
        .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "o timeout do fallback não pode ser o default de 15s: {:?}",
        started.elapsed()
    );
    assert!(
        !err.is_empty(),
        "o cliente precisa devolver erro em vez de esperar 15s"
    );
    assert!(
        seen.paths
            .lock()
            .await
            .iter()
            .any(|p| p == "/internal/search/fallback"),
        "a chamada chegou à rota antes do corte"
    );
}

#[tokio::test]
async fn fallback_deadline_vencido_nao_chama_rede() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let err = client(&base)
        .fallback(&fallback_request(Some(now_ms() - 1_000)))
        .await
        .unwrap_err();
    assert!(err.contains("deadline"), "{err}");
    assert!(seen.bodies.lock().await.is_empty());
}

#[tokio::test]
async fn index_write_e_effects_parseiam() {
    let seen = Arc::new(Seen::default());
    let base = serve(seen.clone()).await;
    let c = client(&base);

    let written = c
        .index_write(&IndexWriteRequest {
            encoded: ENCODED.into(),
            releases: vec![ReleaseEntry {
                imdb: "tt0000001".into(),
                season: None,
                episode: None,
                items: vec![json!({ "title": "x" })],
                entered: None,
                survivors: None,
                source: None,
            }],
        })
        .await
        .unwrap();
    assert_eq!(written.recorded, 2);
    assert_eq!(written.bank_marked, 1);

    let mut payload = Map::new();
    payload.insert("imdbId".into(), json!("tt0000001"));
    payload.insert("type".into(), json!("movie"));
    let effects = c
        .effects(&EffectsRequest {
            encoded: ENCODED.into(),
            effects: vec![EffectEntry {
                kind: "br_probe".into(),
                payload,
            }],
        })
        .await
        .unwrap();
    assert_eq!(effects.accepted, 1);
    assert_eq!(effects.rejected, 0);

    let paths = seen.paths.lock().await.clone();
    assert!(paths.iter().any(|p| p.ends_with("/index-write")));
    assert!(paths.iter().any(|p| p.ends_with("/effects")));
}

#[test]
fn task_scope_serializa_lowercase() {
    let mut map = BTreeMap::new();
    map.insert("task_scope", TaskScope::Nonpriority);
    let v = serde_json::to_value(map).unwrap();
    assert_eq!(v["task_scope"], json!("nonpriority"));
}

#[test]
fn new_recusa_host_nao_loopback() {
    assert!(InternalSearchClient::new("http://example.com:7100", TOKEN, DEFAULT_TIMEOUT).is_err());
    assert!(InternalSearchClient::new("http://127.0.0.1:7100", TOKEN, DEFAULT_TIMEOUT).is_ok());
}
