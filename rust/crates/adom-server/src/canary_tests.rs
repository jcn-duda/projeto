use super::*;

use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Body as AxumBody;
use axum::extract::State;
use axum::routing::any;
use axum::Router;
use http::header::HOST;
use http::{HeaderName, HeaderValue};
use serde_json::Value;

const PATH: &str = "/stream/movie/tt0133093.json";
/// Bucket FNV-1a 64 conhecido (hash do path) — trava o algoritmo.
const PATH_BUCKET: u64 = 99;
/// Série com bucket abaixo de 50 — o par "amostra/não amostra" do teste 50%.
const SERIES: &str = "/stream/series/tt0903747:1:1.json";
const SERIES_BUCKET: u64 = 25;

#[test]
fn percentual_aceita_0_a_100_e_faz_clamp() {
    assert_eq!(percent_from_raw(None), 0);
    assert_eq!(percent_from_raw(Some("")), 0);
    assert_eq!(percent_from_raw(Some("   ")), 0);
    assert_eq!(percent_from_raw(Some("0")), 0);
    assert_eq!(percent_from_raw(Some("5")), 5);
    assert_eq!(percent_from_raw(Some("50")), 50);
    assert_eq!(percent_from_raw(Some("100")), 100);
    assert_eq!(percent_from_raw(Some("101")), 100);
    assert_eq!(percent_from_raw(Some("-3")), 0);
    assert_eq!(percent_from_raw(Some("abc")), 0);
}

#[test]
fn selecao_e_deterministica_por_path_0_50_100() {
    assert_eq!(bucket(PATH), PATH_BUCKET);
    assert_eq!(bucket(SERIES), SERIES_BUCKET);

    for path in [PATH, SERIES] {
        assert!(!is_sampled(path, 0), "0% nunca amostra: {path}");
        assert!(is_sampled(path, 100), "100% sempre amostra: {path}");
        // Mesmo path → mesmo balde em toda chamada (não repete/omite).
        let expected = bucket(path) < 50;
        for _ in 0..16 {
            assert_eq!(is_sampled(path, 50), expected, "50% instável: {path}");
        }
    }
    assert!(is_sampled(SERIES, 50), "bucket 25 < 50");
    assert!(!is_sampled(PATH, 50), "bucket 99 >= 50");
}

#[test]
fn distribuicao_de_50_por_cento_cobre_os_dois_lados() {
    let mut yes = 0;
    for index in 0..400 {
        let path = format!("/stream/movie/tt{index:07}.json");
        if is_sampled(&path, 50) {
            yes += 1;
        }
    }
    assert!(
        yes > 120 && yes < 280,
        "50% deveria ficar perto de 200 de 400, veio {yes}"
    );
}

fn uri() -> Uri {
    "http://127.0.0.1:7100".parse().unwrap()
}

#[test]
fn percentual_zero_nao_planeja_segunda_request() {
    let base = std::env::temp_dir();
    // Mesmo com a base congelada disponível, 0% não cria plano.
    assert!(plan_parts(
        PATH,
        &HeaderMap::new(),
        &uri(),
        Some(base.clone()),
        0,
        "abc123".into(),
    )
    .is_none());
    // E é o default do processo (OFF).
    assert_eq!(percent_from_raw(None), 0);
}

#[test]
fn canary_com_base_so_planeja_quando_amostrado() {
    let base = std::env::temp_dir();
    let request = Request::builder().uri(PATH).body(Body::empty()).unwrap();
    let off = Canary::with_base(0, Some(base.clone()));
    assert!(off.plan(&request, &uri()).is_none(), "0% fica inerte");
    let on = Canary::with_base(100, Some(base));
    let plan = on.plan(&request, &uri()).expect("100% planeja");
    assert_eq!(plan.request.path, PATH);
    assert!(plan.request.shadow_id.is_some());
}

#[test]
fn amostra_planeja_encoded_id_e_headers_do_gateway() {
    let mut headers = HeaderMap::new();
    headers.insert(HOST, HeaderValue::from_static("publico.example"));
    headers.insert(USER_AGENT, HeaderValue::from_static("Stremio/1.6"));
    // Header de sombra forjado pelo cliente não atravessa.
    headers.insert(
        HeaderName::from_static(shadow::SHADOW_ID_HEADER),
        HeaderValue::from_static("forjado"),
    );
    let base = std::env::temp_dir();
    let plan = plan_parts(
        "/e30/stream/movie/tt0133093.json",
        &headers,
        &uri(),
        Some(base),
        100,
        "abc123".into(),
    )
    .expect("100% planeja");

    assert_eq!(plan.encoded, "e30");
    assert_eq!(plan.request.path, "/e30/stream/movie/tt0133093.json");
    assert_eq!(plan.request.shadow_id.as_deref(), Some("abc123"));
    assert!(plan.request.frozen_base.is_some());
    assert_eq!(plan.request.user_agent.as_deref(), Some("Stremio/1.6"));
    assert_eq!(
        plan.request.origin.as_deref(),
        Some("http://publico.example")
    );
    assert!(plan
        .request
        .headers
        .get(HeaderName::from_static(shadow::SHADOW_ID_HEADER))
        .is_none());
}

/// Stub do Node: na request frozen grava um caso mínimo e devolve aviso vazio
/// (`streams: []`). Qualquer outra rota responde `{ok,options}`.
type Hits = Arc<Mutex<usize>>;

async fn spawn_stub(base: PathBuf) -> (SocketAddr, Hits) {
    async fn handler(
        State((base, hits)): State<(PathBuf, Hits)>,
        request: http::Request<AxumBody>,
    ) -> axum::Json<Value> {
        if request
            .headers()
            .get(shadow::SHADOW_FROZEN_HEADER)
            .is_some()
        {
            *hits.lock().unwrap() += 1;
            let id = request
                .headers()
                .get(shadow::SHADOW_ID_HEADER)
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .to_string();
            let dir = base.join(&id);
            fs::create_dir_all(dir.join("inputs")).unwrap();
            fs::write(
                dir.join("request.json"),
                r#"{"type":"movie","stream_id":"tt0133093","encoded_len":0}"#,
            )
            .unwrap();
            fs::write(dir.join("inputs/meta.json"), "{}").unwrap();
            fs::write(dir.join("inputs/collect.json"), "[]").unwrap();
            return axum::Json(serde_json::json!({"streams": [], "cacheMaxAge": 0}));
        }
        axum::Json(serde_json::json!({"ok": true, "options": {}}))
    }

    let hits: Hits = Arc::new(Mutex::new(0));
    let app = Router::new()
        .fallback(any(handler))
        .with_state((base, hits.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, hits)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn percentual_zero_nao_toca_o_node() {
    let temp = tempfile::tempdir().expect("tempdir");
    let base = temp.path().to_path_buf();
    let (addr, hits) = spawn_stub(base.clone()).await;
    let node_base: Uri = format!("http://{addr}").parse().unwrap();
    let canary = Canary::with_base(0, Some(base));
    let request = Request::builder().uri(PATH).body(Body::empty()).unwrap();
    assert!(canary.plan(&request, &node_base).is_none());
    tokio::task::yield_now().await;
    assert_eq!(*hits.lock().unwrap(), 0, "0% não faz segunda request");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn amostra_dispara_exatamente_uma_segunda_request() {
    let temp = tempfile::tempdir().expect("tempdir");
    let base = temp.path().to_path_buf();
    let (addr, hits) = spawn_stub(base.clone()).await;
    let node_base: Uri = format!("http://{addr}").parse().unwrap();

    let plan = plan_parts(
        PATH,
        &HeaderMap::new(),
        &node_base,
        Some(base),
        100,
        "abc123".into(),
    )
    .expect("100% planeja");
    let metrics = CanaryMetrics::new(100);
    run(plan, metrics.clone()).await;

    assert_eq!(*hits.lock().unwrap(), 1, "uma única segunda request");
    let snap = metrics.snapshot();
    assert_eq!(snap[SAMPLED], 1);
    assert_eq!(snap[PERCENT], 100);
    // `{"streams":[]}` é aviso/coleta vazia: não é comparável (§9.4 item 6).
    assert_eq!(snap[SKIPPED], 1);
    assert_eq!(snap[COMPARED], 0);
    assert_eq!(snap[DIVERGENCE], 0);
    assert_eq!(snap[ERROR], 0);
}

#[test]
fn metricas_do_canario_expoem_percentual_e_chaves_zeradas() {
    let metrics = CanaryMetrics::new(50);
    let snap = metrics.snapshot();
    assert_eq!(snap[PERCENT], 50);
    for key in KEYS {
        assert_eq!(snap.get(*key), Some(&0), "chave {key} deve iniciar em 0");
    }
    metrics.inc(COMPARED, 1);
    metrics.inc(DIVERGENCE, 1);
    metrics.inc(DIVERGENCE_ITEMS, 3);
    let snap = metrics.snapshot();
    assert_eq!(snap[COMPARED], 1);
    assert_eq!(snap[DIVERGENCE], 1);
    assert_eq!(snap[DIVERGENCE_ITEMS], 3);
}
