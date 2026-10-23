use super::*;
use adom_core::encode_config;
use adom_debrid::DebridError;
use serde_json::json;

#[tokio::test]
async fn stream_nativo_responde_sem_tocar_o_upstream() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway_state(gateway_state_native(upstream, stub_orchestrator())).await;

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

    // Série com `:` codificado (como Stremio e app mandam) também corta: antes
    // caía no upstream e o Node respondia 410.
    let req = Request::builder()
        .uri("/e30/stream/series/tt2356777%3A1%3A1.json")
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
    let gateway = spawn_gateway_state(gateway_state_native(upstream, stub_orchestrator())).await;

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
async fn stream_nativo_false_ainda_proxy() {
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway_state(gateway_state(upstream, false)).await;
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
    assert!(Config::parse("127.0.0.1:9", "http://", "", String::new()).is_err());
    let ok = Config::parse(
        "127.0.0.1:9",
        "http://127.0.0.1:7100",
        "health",
        String::new(),
    )
    .unwrap();
    assert!(ok.native_health);
    assert!(!ok.stream_native);

    let native = Config::parse(
        "127.0.0.1:9",
        "http://127.0.0.1:7100",
        "stream",
        String::new(),
    )
    .unwrap();
    assert!(native.stream_native);

    // `RESOLVE_SECRET` é o único campo do play: a rota não tem token/flag.
    let resolve = Config::parse(
        "127.0.0.1:9",
        "http://127.0.0.1:7100",
        "resolve",
        "sec".into(),
    )
    .unwrap();
    assert!(!resolve.stream_native);
    assert_eq!(resolve.resolve_secret, "sec");
}

#[test]
fn gateway_on_so_com_valor_exato() {
    assert!(crate::gateway_on("on"));
    assert!(!crate::gateway_on(""));
    assert!(!crate::gateway_on("off"));
    assert!(!crate::gateway_on("ON"));
}

#[tokio::test]
async fn metrics_expoe_checagem_alldebrid_zerada() {
    let (upstream, _hits) = spawn_upstream().await;
    let gateway = spawn_gateway(upstream, false).await;
    let metrics_req = Request::builder()
        .uri("/metrics")
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(gateway, metrics_req).await;
    assert_eq!(status, StatusCode::OK);
    let snap: Value = serde_json::from_str(&body).unwrap();
    // Namespace da checagem AllDebrid nativa × Node, zerado por padrão.
    assert_eq!(snap["debrid.al.native.checks"], 0);
    // As métricas dos caminhos nativos continuam no snapshot.
    assert!(snap.get("account.rust.fetch").is_some());
    assert!(snap.get("index.rust.lookup").is_some());
    // Metadados nativos × fallback Node (Fase 2): chaves presentes e zeradas
    // neste gateway que ainda não atendeu busca.
    for key in [
        "meta.resolve.total",
        "meta.native.incomplete",
        "meta.fallback.used",
        "meta.fallback.empty",
        "meta.fallback.error",
    ] {
        assert_eq!(snap.get(key), Some(&json!(0)), "{key} zerada");
    }
}

// ── `/resolve` NATIVO (sem flag: é o caminho único do gateway) ─────────────

fn config_segment(service: &str, key: &str) -> String {
    encode_config(&json!({ "ds": service, "dk": key }))
}

fn signed_url(secret: &str, service: &str, key: &str, hash: &str, hint: bool) -> String {
    use adom_search::{ResolveSigner, WorkHint};
    let segment = config_segment(service, key);
    let signer = ResolveSigner {
        prefix: format!("/{segment}"),
        secret: secret.into(),
        season: hint.then_some(2),
        episode: hint.then_some(5),
        work_hint: hint.then(|| WorkHint {
            names: vec!["Filme".into()],
            year: Some(2024),
        }),
        ..ResolveSigner::default()
    };
    signer.url(hash, hint, false)
}

async fn call_native(
    resolver: Arc<dyn crate::resolve_native::PlayResolver>,
    secret: &str,
    url: String,
) -> (StatusCode, http::HeaderMap, String) {
    let (upstream, hits) = spawn_upstream().await;
    let gateway = spawn_gateway_state(gateway_state_resolve(upstream, secret, resolver)).await;
    let req = Request::builder()
        .uri(url)
        .header(HOST, "publico.example")
        .body(Body::empty())
        .unwrap();
    let (status, headers, body) = call_full(gateway, req).await;
    assert_eq!(
        hits.0.load(Ordering::SeqCst),
        0,
        "o play nativo não pode encostar no Node"
    );
    (status, headers, body)
}

#[tokio::test]
async fn resolve_nativo_302_para_o_link_do_adaptador() {
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let stub = StubResolver::ok("https://cdn.test/play.mkv");
    let url = signed_url("segredo", "premiumize", "chave-do-usuario", hash, false);
    let (status, headers, _body) = call_native(stub.clone(), "segredo", url).await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(
        headers.get(http::header::LOCATION).unwrap(),
        "https://cdn.test/play.mkv"
    );
    assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
    let seen = stub.seen.lock().unwrap();
    assert_eq!(seen[0].0, "premiumize");
    assert_eq!(seen[0].1, "chave-do-usuario");
}

#[tokio::test]
async fn resolve_nativo_403_com_hmac_errado_nao_chama_adaptador() {
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let stub = StubResolver::ok("https://cdn.test/play.mkv");
    // Assinado com OUTRO segredo: o verify do gateway tem que recusar antes.
    let url = signed_url("outro-segredo", "premiumize", "chave", hash, false);
    let (status, _headers, body) = call_native(stub.clone(), "segredo", url).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, "assinatura inválida");
    assert_eq!(stub.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn resolve_nativo_400_hash_invalido() {
    let stub = StubResolver::ok("https://cdn.test/play.mkv");
    let (status, _headers, body) = call_native(stub, "segredo", "/resolve/aa".into()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, "infoHash inválido");
}

#[tokio::test]
async fn resolve_nativo_400_hash_nulo() {
    let stub = StubResolver::ok("https://cdn.test/play.mkv");
    let (status, _headers, body) =
        call_native(stub, "segredo", format!("/resolve/{}", "0".repeat(40))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, "infoHash inválido");
}

#[tokio::test]
async fn resolve_nativo_404_sem_config_de_debrid() {
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let segment = encode_config(&json!({ "ds": "", "dk": "" }));
    let stub = StubResolver::ok("https://cdn.test/play.mkv");
    let url = format!("/{segment}/resolve/{hash}");
    let (status, _headers, body) = call_native(stub.clone(), "segredo", url).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, "o torrent ainda está baixando no debrid");
    assert_eq!(stub.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn resolve_nativo_erros_fieis_do_contrato_node() {
    use adom_core::{EpisodeContext, PickCode};
    use adom_debrid::DebridError;

    let hash = "0123456789abcdef0123456789abcdef01234567";
    let cases: Vec<(DebridError, StatusCode, &str)> = vec![
        (
            DebridError::from_pick(PickCode::NoVideo, None, None),
            StatusCode::NOT_FOUND,
            "nenhum arquivo de vídeo no torrent",
        ),
        (
            DebridError::Blocked("legal".into()),
            StatusCode::UNAVAILABLE_FOR_LEGAL_REASONS,
            "o debrid bloqueou este conteúdo por motivo legal",
        ),
        (
            DebridError::RateLimit {
                message: "slow".into(),
                retry_after_ms: None,
            },
            StatusCode::TOO_MANY_REQUESTS,
            "o debrid está limitando as requisições; espere um pouco e tente de novo",
        ),
        (
            DebridError::from_pick(
                PickCode::EpisodePick,
                None,
                Some(EpisodeContext {
                    video_count: 3,
                    samples: vec!["a.mkv".into()],
                }),
            ),
            StatusCode::NOT_FOUND,
            "este episódio não foi encontrado no pack",
        ),
        (
            DebridError::from_pick(PickCode::WorkPick, None, None),
            StatusCode::NOT_FOUND,
            "não foi possível identificar este filme dentro do pack",
        ),
        (
            DebridError::from_pick(PickCode::DubLie, None, None),
            StatusCode::NOT_FOUND,
            "o torrent anunciado como dublado contém conteúdo em inglês",
        ),
        (
            DebridError::Auth("apikey=segredo".into()),
            StatusCode::BAD_GATEWAY,
            "falha ao resolver no debrid",
        ),
    ];
    for (error, want_status, want_body) in cases {
        let stub = StubResolver::err(error);
        let url = signed_url("segredo", "premiumize", "chave", hash, false);
        let (status, _headers, body) = call_native(stub, "segredo", url).await;
        assert_eq!(status, want_status, "corpo: {body}");
        assert_eq!(body, want_body);
    }
}

#[tokio::test]
async fn resolve_nativo_alldebrid_magnet_too_many_e_502_explicito() {
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let stub = StubResolver::err(DebridError::Quota(
        "Magnets limit reached (MAGNET_TOO_MANY)".into(),
    ));
    let url = signed_url("segredo", "alldebrid", "chave", hash, false);
    let (status, _headers, body) = call_native(stub.clone(), "segredo", url).await;
    // O teto da conta não pode virar 404 "ainda baixando" nem cair no proxy.
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body, "falha ao resolver no debrid");
    assert_eq!(stub.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn resolve_nativo_hint_w_e_s_e_chegam_ao_adaptador() {
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let stub = StubResolver::ok("https://cdn.test/play.mkv");
    let url = signed_url("segredo", "torbox", "chave", hash, true);
    let (status, _headers, _body) = call_native(stub.clone(), "segredo", url).await;
    assert_eq!(status, StatusCode::FOUND);
    let seen = stub.seen.lock().unwrap();
    let hint = &seen[0].2;
    assert_eq!(hint.season, Some(2));
    assert_eq!(hint.episode, Some(5));
    assert!(hint.dubbed);
    assert_eq!(
        hint.work.as_ref().map(|work| work.names.clone()),
        Some(vec!["Filme".into()])
    );
    assert_eq!(hint.work.as_ref().and_then(|work| work.year), Some(2024));
}
