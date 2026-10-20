use super::*;
use std::fs;
use std::net::SocketAddr;
use std::sync::Arc;

use adom_search::orchestrator::{NoDebridFactory, OrchestratorConfig};
use adom_search::MemorySwrStore;

fn item_ih(hash: &str) -> StreamItem {
    StreamItem {
        info_hash: Some(hash.to_string()),
        ..StreamItem::default()
    }
}

fn item_url(url: &str) -> StreamItem {
    StreamItem {
        url: Some(url.to_string()),
        ..StreamItem::default()
    }
}

#[test]
fn mascara_host_sig_e_config() {
    let raw = "https://powermovie.net/eyJ4IjoxfQ/resolve/abc123def?sig=DEADBEEF&x=1";
    assert_eq!(
        mask_url(raw, Some("eyJ4IjoxfQ")),
        "/{{config}}/resolve/abc123def?sig={{sig}}&x=1"
    );
}

#[test]
fn identidade_ignora_ordem_e_host() {
    let a = vec![
        item_url("https://a.test/resolve/AAAA?sig=1"),
        item_ih("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ];
    let b = vec![
        item_ih("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
        item_url("http://outro.host/resolve/AAAA?sig=ZZZ"),
    ];
    assert_eq!(identity_set(&a, None), identity_set(&b, None));
    assert_eq!(
        divergent_item_count(&identity_set(&a, None), &identity_set(&b, None)),
        0
    );
}

#[test]
fn divergence_conta_itens_da_diferenca_simetrica() {
    let metrics = ShadowMetrics::new();
    let node = StreamResponse {
        streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        cache_max_age: 0,
    };
    let rust = StreamResponse {
        streams: vec![item_ih("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
        cache_max_age: 0,
    };
    record_comparison(&node, &rust, None, &metrics);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(DIVERGENCE), 1);
    assert_eq!(metrics.get(DIVERGENCE_ITEMS), 2);
}

#[test]
fn paridade_nao_marca_divergence() {
    let metrics = ShadowMetrics::new();
    let body = StreamResponse {
        streams: vec![item_ih("cccccccccccccccccccccccccccccccccccccccc")],
        cache_max_age: 900,
    };
    record_comparison(&body, &body, None, &metrics);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE_ITEMS), 0);
}

#[test]
fn shadow_orchestrator_e_compare_only_sem_debrid() {
    let orch = crate::stream::build_shadow_orchestrator();
    assert!(orch.shadow_mode(), "sombra exige shadow_mode");
}

#[tokio::test]
async fn observe_sem_remount_ainda_pula() {
    let metrics = ShadowMetrics::new();
    let body = serde_json::to_vec(&StreamResponse {
        streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        cache_max_age: 0,
    })
    .unwrap();
    observe_node_response(
        StatusCode::OK,
        Bytes::from(body),
        req_com_captura(None, None),
        metrics.clone(),
        None,
    )
    .await;
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(ERROR), 0);
}

#[tokio::test]
async fn observe_com_remount_shadow_sobe_compared_sem_debrid() {
    let metrics = ShadowMetrics::new();
    // Collector default falha → lista/aviso; sem AdapterDebridFactory.
    let orch = Orchestrator::new(
        OrchestratorConfig::default(),
        Arc::new(MemorySwrStore::new()),
    )
    .with_shadow_mode(true)
    .with_debrid(Arc::new(NoDebridFactory));
    assert!(orch.shadow_mode());

    let body = serde_json::to_vec(&StreamResponse {
        streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        cache_max_age: 0,
    })
    .unwrap();
    observe_node_response(
        StatusCode::OK,
        Bytes::from(body),
        req_com_captura(None, None),
        metrics.clone(),
        Some(orch),
    )
    .await;
    assert_eq!(metrics.get(COMPARED), 1);
    // Corpos diferem (Node com ih vs aviso/vazio do stub) → divergence ok;
    // o que importa: compared sobe e o caminho não panica sem debrid.
    assert_eq!(metrics.get(TIMEOUT), 0);
    assert_eq!(metrics.get(ERROR), 0);
}

// ── captura congelada (id/dir/segunda request) ──────────────────────────────

/// Request de teste: `node_base` aponta para uma porta fechada (o fluxo só a
/// usa quando `frozen_base` está setado; os testes que a exercitam trocam).
fn req_com_captura(id: Option<&str>, base: Option<PathBuf>) -> ShadowRequest {
    ShadowRequest {
        path: "/stream/movie/tt0133093.json".into(),
        user_agent: Some("Stremio/1.6".into()),
        origin: Some("http://publico.example".into()),
        shadow_id: id.map(str::to_string),
        frozen_base: base,
        direct: false,
        headers: HeaderMap::new(),
        node_base: "http://127.0.0.1:1".parse().unwrap(),
    }
}

#[test]
fn modo_direto_so_com_valor_exato() {
    assert!(direct_from_raw(Some("direct")));
    assert!(direct_from_raw(Some(" DIRECT ")));
    assert!(!direct_from_raw(None));
    assert!(!direct_from_raw(Some("")));
    assert!(!direct_from_raw(Some("frozen")));
    assert!(!direct_from_raw(Some("shadow")));
}

#[tokio::test]
async fn modo_direto_pula_captura_mesmo_com_base() {
    let metrics = ShadowMetrics::new();
    let body = serde_json::to_vec(&StreamResponse {
        streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        cache_max_age: 0,
    })
    .unwrap();
    let mut req = req_com_captura(Some("abc123"), Some(std::env::temp_dir()));
    req.direct = true;
    // Sem remount: o modo direto não cai na captura congelada (porta 1
    // fechada viraria `error` no fluxo frozen).
    observe_node_response(
        StatusCode::OK,
        Bytes::from(body),
        req,
        metrics.clone(),
        None,
    )
    .await;
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(ERROR), 0, "direto sem remount pula, não erra");
    assert_eq!(metrics.get(TIMEOUT), 0);
}

#[tokio::test]
async fn modo_direto_com_remount_compara_corpo_normal() {
    let metrics = ShadowMetrics::new();
    let orch = Orchestrator::new(
        OrchestratorConfig::default(),
        Arc::new(MemorySwrStore::new()),
    )
    .with_shadow_mode(true)
    .with_debrid(Arc::new(NoDebridFactory));
    let body = serde_json::to_vec(&StreamResponse {
        streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        cache_max_age: 0,
    })
    .unwrap();
    let mut req = req_com_captura(Some("abc123"), Some(std::env::temp_dir()));
    req.direct = true;
    observe_node_response(
        StatusCode::OK,
        Bytes::from(body),
        req,
        metrics.clone(),
        Some(orch),
    )
    .await;
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(ERROR), 0);
}

#[test]
fn id_do_shadow_so_aceita_hex_e_hifen() {
    assert!(valid_shadow_id("1a2b3c"));
    assert!(valid_shadow_id("6b1f2a3c-1a2-0"));
    assert!(!valid_shadow_id(""));
    assert!(!valid_shadow_id("../etc"));
    assert!(!valid_shadow_id("abc/def"));
    assert!(!valid_shadow_id("id com espaço"));
}

#[test]
fn loopback_do_config_recusa_host_externo() {
    assert!(is_loopback_base("http://127.0.0.1:7100"));
    assert!(is_loopback_base("http://localhost:7100/"));
    assert!(is_loopback_base("http://[::1]:7100"));
    assert!(!is_loopback_base("http://10.0.0.2:7100"));
    assert!(!is_loopback_base("https://powermovie.net"));
    assert!(!is_loopback_base("127.0.0.1:7100"));
}

#[tokio::test]
async fn segunda_request_falha_nao_vira_divergencia() {
    let metrics = ShadowMetrics::new();
    let body = serde_json::to_vec(&StreamResponse {
        streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        cache_max_age: 0,
    })
    .unwrap();
    // Porta 1 fechada: a segunda request frozen falha; a resposta NORMAL não
    // pode virar divergência.
    observe_node_response(
        StatusCode::OK,
        Bytes::from(body),
        req_com_captura(Some("abc123"), Some(std::env::temp_dir())),
        metrics.clone(),
        None,
    )
    .await;
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE_ITEMS), 0);
    assert_eq!(metrics.get(ERROR), 1);
}

/// Stub do Node: devolve `body` e registra path + headers de cada request.
type StubHit = (String, HeaderMap);
type StubHits = Arc<Mutex<Vec<StubHit>>>;

async fn spawn_frozen_stub(body: Value) -> (SocketAddr, StubHits) {
    async fn handler(
        axum::extract::State((body, hits)): axum::extract::State<(Value, StubHits)>,
        request: axum::extract::Request,
    ) -> axum::Json<Value> {
        hits.lock()
            .unwrap()
            .push((request.uri().path().to_string(), request.headers().clone()));
        axum::Json(body)
    }
    let hits: StubHits = Arc::new(Mutex::new(Vec::new()));
    let app = axum::Router::new()
        .fallback(axum::routing::any(handler))
        .with_state((body, hits.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, hits)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn segunda_request_leva_id_frozen_e_herda_host_ua() {
    let expected = serde_json::json!({"streams": [], "cacheMaxAge": 0});
    let (addr, hits) = spawn_frozen_stub(expected.clone()).await;

    let mut headers = HeaderMap::new();
    headers.insert(
        http::header::HOST,
        HeaderValue::from_static("publico.example"),
    );
    headers.insert(
        http::header::USER_AGENT,
        HeaderValue::from_static("Stremio/1.6"),
    );
    let mut req = req_com_captura(Some("abc123"), Some(std::env::temp_dir()));
    req.path = "/eyJ4IjoxfQ/stream/movie/tt0133093.json".into();
    req.headers = headers;
    req.node_base = format!("http://{addr}").parse().unwrap();

    let got = capture_frozen_body(&req, "abc123")
        .await
        .expect("segunda request");
    assert_eq!(got, expected);

    let seen = hits.lock().unwrap();
    assert_eq!(seen.len(), 1, "uma única segunda request");
    let (path, headers) = &seen[0];
    assert_eq!(path, "/eyJ4IjoxfQ/stream/movie/tt0133093.json");
    assert_eq!(headers.get(SHADOW_ID_HEADER).unwrap(), "abc123");
    assert_eq!(headers.get(SHADOW_FROZEN_HEADER).unwrap(), "1");
    // Mesmo origin da request normal: o Node calcula `{{base}}` igual.
    assert_eq!(headers.get(http::header::HOST).unwrap(), "publico.example");
    assert_eq!(
        headers.get(http::header::USER_AGENT).unwrap(),
        "Stremio/1.6"
    );
    // Pedido de compressão/cache não pode transformar a resposta (204/304).
    assert!(headers.get(http::header::ACCEPT_ENCODING).is_none());
    assert!(headers.get(http::header::IF_NONE_MATCH).is_none());
}

#[tokio::test]
async fn espera_do_dir_aceita_captura_completa() {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("adom-shadow-wait-{}-{nanos}", std::process::id()));
    fs::create_dir_all(dir.join("inputs")).unwrap();

    assert!(
        wait_frozen_case(&dir, Duration::from_millis(40))
            .await
            .is_err(),
        "sem collect/meta/request não há captura"
    );
    fs::write(dir.join("request.json"), "{}").unwrap();
    fs::write(dir.join("inputs/collect.json"), "[]").unwrap();
    fs::write(dir.join("inputs/meta.json"), "{}").unwrap();
    assert!(wait_frozen_case(&dir, Duration::from_millis(40))
        .await
        .is_ok());

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn aviso_de_coleta_vazia_nao_e_comparavel() {
    // Envelope real do aviso: o campo `notice` NÃO sobrevive à resposta; sobra
    // o nome e o externalUrl do /configure.
    let envelope = serde_json::json!({
        "streams": [{
            "name": "Procurando fontes — reabra em instantes",
            "externalUrl": "http://127.0.0.1:7100/e30/configure"
        }]
    });
    assert!(notice_only(&envelope));
    // Com a flag também vale; lista vazia vale; lista tocável NÃO vale.
    assert!(notice_only(&serde_json::json!({
        "streams": [{ "name": "Nada pronto ainda", "notice": true }]
    })));
    assert!(notice_only(&serde_json::json!({ "streams": [] })));
    assert!(!notice_only(&serde_json::json!({
        "streams": [{
            "name": "1080p BluRay",
            "url": "/e30/resolve/abc",
            "infoHash": "abc"
        }]
    })));
    // Lista mista (tocável + aviso) é comparável: o aviso anexado não apaga o
    // que toca.
    assert!(!notice_only(&serde_json::json!({
        "streams": [
            { "name": "1080p BluRay", "url": "/e30/resolve/abc" },
            { "name": "Procurando fontes — reabra em instantes", "externalUrl": "x/configure" }
        ]
    })));
}

fn copy_case_dir(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap() {
        let entry = entry.unwrap();
        let target = dst.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_case_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Regressão `da794cad`: com a captura congelada ligada, a segunda request
/// grava o caso e o replay conta `stream.shadow.compared`. O teste usa um caso
/// REAL do corpus (movie-inception) e um stub que devolve o `expected`; não
/// depende de `STREAM_FROZEN_MODE` nem de Node.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sombra_congelada_grava_o_dir_e_conta_compared() {
    let src =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden/stream-frozen/movie-inception");
    let temp = tempfile::tempdir().expect("tempdir");
    let case_dir = temp.path().join("abc123");
    copy_case_dir(&src, &case_dir);
    let expected: Value = serde_json::from_str(
        &fs::read_to_string(src.join("expected/node-response.json")).expect("expected do corpus"),
    )
    .expect("expected JSON");
    let body = serde_json::to_vec(&expected).expect("body");

    let (addr, hits) = spawn_frozen_stub(expected.clone()).await;
    let mut headers = HeaderMap::new();
    headers.insert(
        http::header::HOST,
        HeaderValue::from_static("publico.example"),
    );
    let req = ShadowRequest {
        path: "/e30/stream/movie/tt1375666.json".into(),
        user_agent: Some("Stremio/1.6".into()),
        origin: Some("http://127.0.0.1:7100".into()),
        shadow_id: Some("abc123".into()),
        frozen_base: Some(temp.path().to_path_buf()),
        direct: false,
        headers,
        node_base: format!("http://{addr}").parse().unwrap(),
    };
    let metrics = ShadowMetrics::new();
    observe_node_response(
        StatusCode::OK,
        Bytes::from(body),
        req,
        metrics.clone(),
        None,
    )
    .await;

    assert_eq!(
        metrics.get(COMPARED),
        1,
        "snapshot: {:?}",
        metrics.snapshot()
    );
    assert_eq!(metrics.get(ERROR), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(hits.lock().unwrap().len(), 1, "uma segunda request");
    // O dir do caso continua completo (a captura não apaga o corpus).
    assert!(case_dir.join("request.json").is_file());
    assert!(case_dir.join("inputs/meta.json").is_file());
    assert!(case_dir.join("inputs/config.json").is_file());
}
