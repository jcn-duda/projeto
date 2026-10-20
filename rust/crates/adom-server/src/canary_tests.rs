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
fn modo_direct_so_com_valor_exato() {
    assert_eq!(mode_from_raw(Some("direct")), Mode::Direct);
    assert_eq!(mode_from_raw(Some(" DIRECT ")), Mode::Direct);
    assert_eq!(mode_from_raw(Some("direct ")), Mode::Direct);
    // Default/rollback: qualquer outra coisa é o caminho congelado.
    assert_eq!(mode_from_raw(None), Mode::Frozen);
    assert_eq!(mode_from_raw(Some("")), Mode::Frozen);
    assert_eq!(mode_from_raw(Some("frozen")), Mode::Frozen);
    assert_eq!(mode_from_raw(Some("100")), Mode::Frozen);
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
        Mode::Frozen,
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
    assert_eq!(plan.mode, Mode::Frozen);
    assert!(plan.request.frozen_base.is_some());
}

#[test]
fn modo_direto_nao_exige_base_congelada() {
    // Sem `STREAM_FROZEN_SHADOW_BASE` e sem dir de corpus, 100% ainda planeja.
    let canary = Canary::with_mode(100, Mode::Direct, None);
    assert!(canary.frozen_base().is_none());
    let request = Request::builder().uri(PATH).body(Body::empty()).unwrap();
    let plan = canary
        .plan(&request, &uri())
        .expect("direto planeja sem base");
    assert_eq!(plan.mode, Mode::Direct);
    assert!(plan.request.direct);
    assert!(plan.request.frozen_base.is_none());
    assert!(plan.request.shadow_id.is_some());
    // 0% continua inerte.
    let off = Canary::with_mode(0, Mode::Direct, None);
    assert!(off.plan(&request, &uri()).is_none());
}

#[test]
fn modo_direto_nao_amostra_head() {
    let canary = Canary::with_mode(100, Mode::Direct, None);
    let head = Request::builder()
        .method(Method::HEAD)
        .uri(PATH)
        .body(Body::empty())
        .unwrap();
    assert!(
        canary.plan(&head, &uri()).is_none(),
        "HEAD não tem corpo para comparar"
    );
    // O modo congelado mantém o comportamento anterior (GET interno da 2ª).
    let frozen = Canary::with_base(100, Some(std::env::temp_dir()));
    assert!(frozen.plan(&head, &uri()).is_some());
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
        Mode::Frozen,
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
        Mode::Frozen,
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
    assert_eq!(snap[DIRECT], 0);
    // `{"streams":[]}` é aviso/coleta vazia: não é comparável (§9.4 item 6).
    assert_eq!(snap[SKIPPED], 1);
    assert_eq!(snap[COMPARED], 0);
    assert_eq!(snap[DIVERGENCE], 0);
    assert_eq!(snap[ERROR], 0);
}

// ── modo direto (F4.3): corpo do corte × Node fresco, sem FrozenCase ───────

/// Stub do Node no modo direto: devolve `body` e registra path + headers.
type Seen = Arc<Mutex<Vec<(String, HeaderMap)>>>;

async fn spawn_direct_stub(body: Value) -> (SocketAddr, Seen) {
    async fn handler(
        State((body, seen)): State<(Value, Seen)>,
        request: http::Request<AxumBody>,
    ) -> axum::Json<Value> {
        seen.lock()
            .unwrap()
            .push((request.uri().path().to_string(), request.headers().clone()));
        axum::Json(body)
    }
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new()
        .fallback(any(handler))
        .with_state((body, seen.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, seen)
}

fn stream_body(hash: &str) -> Value {
    serde_json::json!({
        "streams": [{ "name": "1080p", "title": "x", "infoHash": hash }],
        "cacheMaxAge": 900
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direto_compara_corpo_do_corte_com_node_fresco_sem_captura() {
    let hash = "a".repeat(40);
    let body = stream_body(&hash);
    let (addr, seen) = spawn_direct_stub(body.clone()).await;
    let node_base: Uri = format!("http://{addr}").parse().unwrap();

    let plan = plan_parts(
        PATH,
        &HeaderMap::new(),
        &node_base,
        Mode::Direct,
        None,
        100,
        "abc123".into(),
    )
    .expect("direto planeja sem base");
    let metrics = CanaryMetrics::with_mode(100, Mode::Direct);
    let cut = Bytes::from(serde_json::to_vec(&body).unwrap());
    run_direct(plan, cut, metrics.clone()).await;

    let snap = metrics.snapshot();
    assert_eq!(snap[SAMPLED], 1);
    assert_eq!(snap[DIRECT], 1);
    assert_eq!(snap[COMPARED], 1, "identidades iguais → comparado");
    assert_eq!(snap[DIVERGENCE], 0);
    assert_eq!(snap[ERROR], 0);
    assert_eq!(snap[TIMEOUT], 0);

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "uma única segunda request");
    let (path, headers) = &seen[0];
    assert_eq!(path, PATH);
    // Sem `X-Adom-Shadow-Id`: o Node NÃO grava corpus (o canário direto não
    // depende da captura congelada).
    assert!(headers.get(shadow::SHADOW_ID_HEADER).is_none());
    assert_eq!(headers.get(shadow::SHADOW_FROZEN_HEADER).unwrap(), "1");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direto_acusa_divergencia_de_identidade() {
    let node_body = stream_body(&"a".repeat(40));
    let (addr, _seen) = spawn_direct_stub(node_body).await;
    let node_base: Uri = format!("http://{addr}").parse().unwrap();

    let plan = plan_parts(
        PATH,
        &HeaderMap::new(),
        &node_base,
        Mode::Direct,
        None,
        100,
        "abc123".into(),
    )
    .expect("direto planeja");
    let metrics = CanaryMetrics::with_mode(100, Mode::Direct);
    let cut = Bytes::from(serde_json::to_vec(&stream_body(&"b".repeat(40))).unwrap());
    run_direct(plan, cut, metrics.clone()).await;

    let snap = metrics.snapshot();
    assert_eq!(snap[COMPARED], 1);
    assert_eq!(snap[DIVERGENCE], 1);
    assert_eq!(snap[DIVERGENCE_ITEMS], 2, "diferença simétrica dos ids");
    assert_eq!(snap[ERROR], 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direto_pula_aviso_do_node_mas_nao_o_do_corte() {
    // Node devolve aviso → não comparável (skipped).
    let (addr, _seen) = spawn_direct_stub(serde_json::json!({"streams": []})).await;
    let node_base: Uri = format!("http://{addr}").parse().unwrap();
    let plan = plan_parts(
        PATH,
        &HeaderMap::new(),
        &node_base,
        Mode::Direct,
        None,
        100,
        "abc123".into(),
    )
    .expect("direto planeja");
    let metrics = CanaryMetrics::with_mode(100, Mode::Direct);
    run_direct(
        plan,
        Bytes::from(serde_json::to_vec(&stream_body(&"b".repeat(40))).unwrap()),
        metrics.clone(),
    )
    .await;
    let snap = metrics.snapshot();
    assert_eq!(snap[SKIPPED], 1);
    assert_eq!(snap[COMPARED], 0);
    assert_eq!(snap[DIVERGENCE], 0);

    // Node com lista e corte com aviso → divergência de verdade (o corte
    // esvaziou); NÃO pode ser skipped.
    let (addr, _seen) = spawn_direct_stub(stream_body(&"a".repeat(40))).await;
    let node_base: Uri = format!("http://{addr}").parse().unwrap();
    let plan = plan_parts(
        PATH,
        &HeaderMap::new(),
        &node_base,
        Mode::Direct,
        None,
        100,
        "abc123".into(),
    )
    .expect("direto planeja");
    let metrics = CanaryMetrics::with_mode(100, Mode::Direct);
    run_direct(
        plan,
        Bytes::from(
            serde_json::to_vec(&serde_json::json!({
                "streams": [{ "name": "Procurando fontes — reabra em instantes", "externalUrl": "x/configure" }],
                "cacheMaxAge": 0
            }))
            .unwrap(),
        ),
        metrics.clone(),
    )
    .await;
    let snap = metrics.snapshot();
    assert_eq!(snap[COMPARED], 1, "aviso do corte é comparável");
    assert_eq!(snap[DIVERGENCE], 1);
    assert_eq!(snap[SKIPPED], 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direto_falha_de_rede_nunca_vira_divergencia() {
    // Porta 1 fechada: erro de transporte no oráculo Node.
    let plan = plan_parts(
        PATH,
        &HeaderMap::new(),
        &"http://127.0.0.1:1".parse().unwrap(),
        Mode::Direct,
        None,
        100,
        "abc123".into(),
    )
    .expect("direto planeja");
    let metrics = CanaryMetrics::with_mode(100, Mode::Direct);
    run_direct(
        plan,
        Bytes::from(serde_json::to_vec(&stream_body(&"b".repeat(40))).unwrap()),
        metrics.clone(),
    )
    .await;
    let snap = metrics.snapshot();
    assert_eq!(snap[SAMPLED], 1);
    assert_eq!(snap[ERROR], 1);
    assert_eq!(snap[DIVERGENCE], 0);
}

#[test]
fn contadores_nativos_nao_dependem_do_node() {
    let metrics = CanaryMetrics::with_mode(100, Mode::Direct);
    observe_native(
        &serde_json::to_vec(&stream_body(&"c".repeat(40))).unwrap(),
        &metrics,
    );
    observe_native(br#"{"streams": []}"#, &metrics);
    observe_native(br#"{"streams": [{"name":"Procurando fontes"}]}"#, &metrics);
    observe_native(b"nao-json", &metrics);
    let snap = metrics.snapshot();
    assert_eq!(snap[NATIVE_CUT], 4);
    assert_eq!(snap[NATIVE_STREAMS], 2, "stream_body + item de aviso");
    assert_eq!(snap[NATIVE_EMPTY], 1);
    assert_eq!(snap[NATIVE_NOTICE], 2, "vazio e aviso contam como aviso");
    assert_eq!(snap[NATIVE_INVALID], 1);
    // Fonte sem oráculo: nada de compared/divergence.
    assert_eq!(snap[COMPARED], 0);
    assert_eq!(snap[DIVERGENCE], 0);
}

#[test]
fn metricas_do_canario_expoem_percentual_e_chaves_zeradas() {
    let metrics = CanaryMetrics::new(50);
    let snap = metrics.snapshot();
    assert_eq!(snap[PERCENT], 50);
    assert_eq!(snap[DIRECT], 0);
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

/// Regressão da janela §9.4: o `/metrics` mescla o snapshot do canário DEPOIS
/// do snapshot da sombra (`extend` sobrescreve). Se o canário semear
/// `stream.shadow.*` com zero, `stream.shadow.compared` real vira 0 e a sombra
/// fica invisível (foi o que aconteceu no 512 da imagem `da794cad`).
#[test]
fn snapshot_do_canario_nao_zera_as_metricas_da_sombra() {
    let shadow = ShadowMetrics::new();
    shadow.inc(shadow::COMPARED, 3);
    shadow.inc(shadow::DIVERGENCE, 1);
    shadow.inc(shadow::DIVERGENCE_ITEMS, 2);

    // Nenhuma chave da sombra no snapshot do canário (nem zerada).
    let canary = CanaryMetrics::new(0).snapshot();
    assert!(!canary.contains_key(shadow::COMPARED));
    assert!(!canary.contains_key(shadow::DIVERGENCE));
    assert!(!canary.contains_key(shadow::ERROR));

    // A mescla do `/metrics` preserva os valores reais da sombra.
    let mut merged = shadow.snapshot();
    merged.extend(canary);
    assert_eq!(merged[shadow::COMPARED], 3);
    assert_eq!(merged[shadow::DIVERGENCE], 1);
    assert_eq!(merged[shadow::DIVERGENCE_ITEMS], 2);
    // E as chaves do canário continuam expostas (zeradas inclusive).
    assert_eq!(merged[PERCENT], 0);
    assert_eq!(merged[SKIPPED], 0);
}
