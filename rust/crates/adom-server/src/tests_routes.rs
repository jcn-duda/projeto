use super::*;

#[tokio::test]
async fn stream_nativo_responde_sem_tocar_o_upstream() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway =
        spawn_gateway_state(gateway_state_native(upstream, false, stub_orchestrator())).await;

    let req = Request::builder()
        .uri("/stream/movie/tt0133093.json")
        .header(HOST, "publico.example")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert!(json.get("streams").is_some(), "corpo: {body}");
    assert!(json.get("cacheMaxAge").is_some(), "corpo: {body}");
    assert_eq!(hits.0.load(Ordering::SeqCst), 0);

    // Com config na URL também corta.
    let req = Request::builder()
        .uri("/e30/stream/movie/tt0133093.json")
        .header(HOST, "publico.example")
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(gateway, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hits.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn stream_nativo_path_nao_stream_continua_proxy() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway =
        spawn_gateway_state(gateway_state_native(upstream, false, stub_orchestrator())).await;

    let req = Request::builder()
        .uri("/manifest.json")
        .header(HOST, "publico.example")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["pq"], "/manifest.json");
    assert_eq!(hits.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stream_nativo_tem_prioridade_sobre_shadow() {
    let (upstream, hits) = spawn_upstream().await;
    let state = gateway_state_native(upstream, true, stub_orchestrator());
    let metrics = state.shadow_metrics.clone();
    let gateway = spawn_gateway_state(state).await;

    let req = Request::builder()
        .uri("/stream/movie/tt0133093.json")
        .header(HOST, "publico.example")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert!(json.get("streams").is_some());
    // Sem proxy → sombra do Node não roda.
    assert_eq!(hits.0.load(Ordering::SeqCst), 0);
    tokio::task::yield_now().await;
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE_ITEMS), 0);
}

#[tokio::test]
async fn stream_nativo_false_ainda_proxy() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway_state(gateway_state(upstream, false, false)).await;
    let req = Request::builder()
        .uri("/stream/movie/tt0133093.json")
        .header(HOST, "publico.example")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["method"], "GET");
    assert_eq!(json["pq"], "/stream/movie/tt0133093.json");
    assert_eq!(hits.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn health_nativo_nao_toca_o_upstream() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway(upstream, true).await;
    let health = Request::builder()
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, health).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, r#"{"ok":true}"#);
    assert_eq!(hits.0.load(Ordering::SeqCst), 0);

    let manifest = Request::builder()
        .uri("/manifest.json")
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(gateway, manifest).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(hits.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn upstream_morto_responde_502() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let gateway = spawn_gateway(SocketAddr::from(([127, 0, 0, 1], port)), false).await;
    let req = Request::builder()
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body, "bad_gateway");
}

#[test]
fn upstream_uri_preserva_query() {
    let base = "http://127.0.0.1:7100".parse().unwrap();
    let uri = proxy::upstream_uri(&base, "/stream/movie/x?y=1").unwrap();
    assert_eq!(uri.to_string(), "http://127.0.0.1:7100/stream/movie/x?y=1");
}

#[test]
fn config_rejeita_upstream_sem_host() {
    assert!(Config::parse("127.0.0.1:9", "http://", "", true, String::new()).is_err());
    let ok = Config::parse(
        "127.0.0.1:9",
        "http://127.0.0.1:7100",
        "health",
        true,
        String::new(),
    )
    .unwrap();
    assert!(ok.native_health);
    assert!(!ok.stream_shadow);
    assert!(!ok.stream_native);

    let shadow = Config::parse(
        "127.0.0.1:9",
        "http://127.0.0.1:7100",
        "health,stream-shadow",
        true,
        String::new(),
    )
    .unwrap();
    assert!(shadow.native_health);
    assert!(shadow.stream_shadow);
    assert!(!shadow.stream_native);

    let native = Config::parse(
        "127.0.0.1:9",
        "http://127.0.0.1:7100",
        "stream",
        true,
        String::new(),
    )
    .unwrap();
    assert!(!native.stream_shadow);
    assert!(native.stream_native);

    let resolve = Config::parse(
        "127.0.0.1:9",
        "http://127.0.0.1:7100",
        "resolve",
        false,
        "sec".into(),
    )
    .unwrap();
    assert!(resolve.resolve_native);
    assert!(!resolve.resolve_proxy);
    assert_eq!(resolve.resolve_secret, "sec");
}

#[test]
fn gateway_on_so_com_valor_exato() {
    assert!(crate::gateway_on("on"));
    assert!(!crate::gateway_on(""));
    assert!(!crate::gateway_on("off"));
    assert!(!crate::gateway_on("ON"));
}

#[test]
fn shadow_metrics_snapshot_expoe_chaves_zeradas() {
    let snap = ShadowMetrics::new().snapshot();
    assert_eq!(snap.get(DIVERGENCE), Some(&0));
    assert_eq!(snap.get(DIVERGENCE_ITEMS), Some(&0));
    assert_eq!(snap.get(shadow::COMPARED), Some(&0));
}

#[tokio::test]
async fn metrics_expoe_canario_do_corte_zerado() {
    let (upstream, _hits) = spawn_upstream().await;
    let gateway = spawn_gateway(upstream, false).await;
    let metrics_req = Request::builder()
        .uri("/metrics")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, metrics_req).await;
    assert_eq!(status, StatusCode::OK);
    let snap: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(snap[crate::canary::PERCENT], 0);
    assert_eq!(snap[SAMPLED], 0);
    assert_eq!(snap[crate::canary::DIVERGENCE], 0);
    assert_eq!(snap[crate::canary::ERROR], 0);
}

#[tokio::test]
async fn resolve_nativo_403_sem_tocar_upstream() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway_state(gateway_state_resolve(upstream, "segredo", true)).await;
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let req = Request::builder()
        .uri(format!("/resolve/{hash}?sig=deadbeef"))
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, "assinatura inválida");
    assert_eq!(hits.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn resolve_nativo_501_com_proxy_desligado() {
    use adom_search::ResolveSigner;
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway_state(gateway_state_resolve(upstream, "segredo", false)).await;
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let signer = ResolveSigner {
        prefix: String::new(),
        secret: "segredo".into(),
        ..ResolveSigner::default()
    };
    let url = signer.url(hash, false, false);
    let req = Request::builder().uri(url).body(Body::empty()).unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert!(body.contains("proxy desligado"), "corpo: {body}");
    assert_eq!(hits.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn resolve_nativo_proxy_apos_verify_ok() {
    use adom_search::ResolveSigner;
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway_state(gateway_state_resolve(upstream, "segredo", true)).await;
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let signer = ResolveSigner {
        prefix: String::new(),
        secret: "segredo".into(),
        ..ResolveSigner::default()
    };
    let url = signer.url(hash, false, false);
    let req = Request::builder()
        .uri(url)
        .header(HOST, "publico.example")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, req).await;
    assert_eq!(status, StatusCode::OK);
    let json: Value = serde_json::from_str(&body).unwrap();
    assert!(
        json["pq"]
            .as_str()
            .unwrap()
            .starts_with(&format!("/resolve/{hash}")),
        "pq: {}",
        json["pq"]
    );
    assert_eq!(hits.0.load(Ordering::SeqCst), 1);
}
