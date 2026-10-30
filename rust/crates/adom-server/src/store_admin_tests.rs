use std::sync::Arc;

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use adom_search::{StreamItem, StreamsEntry};
use adom_store::StreamsStore;

use super::{AdminConfig, DEFAULT_LISTEN};

const TOKEN: &str = "token-de-teste";

fn router(
    cfg: &AdminConfig,
    store: Arc<StreamsStore>,
    grace_seconds: u64,
    harvest: Option<crate::harvest::HarvestHandle>,
) -> axum::Router {
    super::router_with_ownership(
        cfg,
        store,
        grace_seconds,
        harvest,
        None,
        None,
        crate::ownership_admin::router(),
        None,
        None,
    )
}

fn entry_with_trace(hash: &str, finished_at: f64) -> StreamsEntry {
    StreamsEntry {
        streams: vec![
            // Resolvido: perdeu `infoHash`, sobrou a URL relativa.
            StreamItem {
                name: Some("1080p".into()),
                url: Some(format!("e30/resolve/{hash}?s=1&e=2&sig=abc&w=x")),
                ..StreamItem::default()
            },
            // P2P: hash no campo.
            StreamItem {
                name: Some("720p".into()),
                info_hash: Some("ffffffffffffffffffffffffffffffffffffffff".into()),
                ..StreamItem::default()
            },
        ],
        debrid_known: Some(true),
        trace: Some(json!({ "startedAt": finished_at - 100.0, "finishedAt": finished_at })),
        search_meta: Some(json!({ "names": ["Filme Teste"], "year": 2024 })),
        ..Default::default()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

async fn spawn(store: Arc<StreamsStore>, token: &str) -> std::net::SocketAddr {
    // Sem a segunda credencial: é a config de quem só tem o token de diagnóstico.
    spawn_with(store, token, None).await
}

/// Sobe o roteador com as DUAS credenciais (a destrutiva pode ser `None`).
async fn spawn_with(
    store: Arc<StreamsStore>,
    token: &str,
    destructive: Option<&str>,
) -> std::net::SocketAddr {
    let cfg = AdminConfig {
        listen: DEFAULT_LISTEN.parse().unwrap(),
        token: token.to_string(),
        destructive_token: destructive.map(str::to_string),
    };
    let app = router(&cfg, store, 300, None);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

async fn call(addr: std::net::SocketAddr, req: Request<Body>) -> (StatusCode, Value) {
    let client = crate::proxy::client();
    let (mut parts, body) = req.into_parts();
    let pq = parts
        .uri
        .path_and_query()
        .map(|item| item.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    parts.uri = format!("http://{addr}{pq}").parse().unwrap();
    let response = client
        .request(Request::from_parts(parts, body))
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

fn post_json(path: &str, body: Value, token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header("x-indexer-test-token", token)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn sem_token_configurado_responde_503_e_token_errado_401() {
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let sem_token = spawn(store.clone(), "").await;
    let (status, body) = call(
        sem_token,
        post_json("/streams/clear", json!({}), "qualquer"),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");

    let com_token = spawn(store, TOKEN).await;
    let (status, _) = call(
        com_token,
        post_json("/streams/clear", json!({}), "outro-token"),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(com_token, post_json("/streams/clear", json!({}), "")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invalida_por_obra_e_por_hash() {
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let prefix = adom_store::streams_prefix();
    let alvo = format!("{prefix}movie:tt123:a");
    let vizinho = format!("{prefix}movie:tt1230:a");
    let hash = "0123456789abcdef0123456789abcdef01234567";
    for key in [&alvo, &vizinho] {
        store
            .set(key, &entry_with_trace(hash, 1.0), 600, 0)
            .unwrap();
    }
    let addr = spawn(store.clone(), TOKEN).await;

    let (status, body) = call(
        addr,
        post_json("/streams/invalidate", json!({ "imdbId": "tt123" }), TOKEN),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removed"], 1);
    assert_eq!(body["scope"], "obra");
    assert_eq!(store.len().unwrap(), 1);

    let (status, body) = call(
        addr,
        post_json("/streams/invalidate", json!({ "hash": hash }), TOKEN),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removed"], 1, "o vizinho também menciona o hash");
    assert_eq!(body["scope"], "hash");
    assert_eq!(store.len().unwrap(), 0);

    // Corpo ambíguo/vazio é 400, e hash malformado também.
    let (status, _) = call(addr, post_json("/streams/invalidate", json!({}), TOKEN)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        addr,
        post_json("/streams/invalidate", json!({ "hash": "curto" }), TOKEN),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn clear_limpa_tudo_ou_so_o_sufixo() {
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let prefix = adom_store::streams_prefix();
    let a = format!("{prefix}movie:tt1:{{\"m\":2}}:account:aaa");
    let b = format!("{prefix}series:tt2:1:1:{{\"m\":2}}:account:bbb");
    for key in [&a, &b] {
        store
            .set(key, &entry_with_trace("aa", 1.0), 600, 0)
            .unwrap();
    }
    let addr = spawn_with(store.clone(), TOKEN, Some(TOKEN)).await;

    let (status, body) = call(
        addr,
        post_json(
            "/streams/clear",
            json!({ "suffix": ":account:aaa", "confirm": true }),
            TOKEN,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removed"], 1);
    assert_eq!(body["scope"], "suffix");
    assert_eq!(store.len().unwrap(), 1);

    let (status, body) = call(
        addr,
        post_json("/streams/clear", json!({ "confirm": true }), TOKEN),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["removed"], 1);
    assert_eq!(body["scope"], "all");
    assert_eq!(store.len().unwrap(), 0);
}

/// Guardas das rotas destrutivas (409 sem `confirm`, 403 com o token de
/// diagnóstico, 409 sem credencial) e a ausência delas no caminho quente.
#[path = "store_admin_tests_clear.rs"]
mod clear;

#[tokio::test]
async fn trace_devolve_ledger_e_hashes_sem_vazar_url() {
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let prefix = adom_store::streams_prefix();
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let key = format!("{prefix}movie:tt9:{{\"m\":2}}:account:abc");
    let entry = entry_with_trace(hash, 1_700_000_000_000.0);
    store.set(&key, &entry, 900, now_ms()).unwrap();
    let addr = spawn(store, TOKEN).await;

    let req = Request::builder()
        .uri("/streams/trace?type=movie&id=tt9")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(addr, req).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    assert_eq!(body["found"], true);
    assert_eq!(body["source"], "rust");
    assert_eq!(body["trace"]["finishedAt"], json!(1_700_000_000_000.0));
    assert_eq!(body["searchMeta"]["names"][0], "Filme Teste");
    assert_eq!(body["cache"]["debridKnown"], true);
    assert_eq!(body["cache"]["stale"], false);
    assert!(body["cache"]["remainingS"].as_u64().unwrap() > 800);
    // O hash resolvido sai da URL; o item P2P sai do campo. A URL crua NÃO.
    let hashes: Vec<&str> = body["streams"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item["infoHash"].as_str())
        .collect();
    assert!(hashes.contains(&hash), "{hashes:?}");
    assert!(
        hashes.contains(&"ffffffffffffffffffffffffffffffffffffffff"),
        "{hashes:?}"
    );
    assert!(
        !body.to_string().contains("/resolve/"),
        "URL não pode vazar: {body}"
    );

    // Chave exata do Node (a mesma `streamsCacheKey`): quando presente, é ela
    // que manda — e a obra errada devolve found:false.
    let req = Request::builder()
        .uri("/streams/trace?type=movie&id=tt9&key=nao-existe")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(addr, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["found"], true,
        "cai no latest da obra quando a chave não existe"
    );

    let req = Request::builder()
        .uri("/streams/trace?type=movie&id=tt0")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(addr, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["found"], false);

    // Tipo fora do contrato: 400.
    let req = Request::builder()
        .uri("/streams/trace?type=anime&id=tt9")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap();
    let (status, _) = call(addr, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn stats_le_ocupacao_e_cota() {
    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let prefix = adom_store::streams_prefix();
    store
        .set(
            &format!("{prefix}movie:tt1:a"),
            &entry_with_trace("aa", 1.0),
            600,
            0,
        )
        .unwrap();
    let addr = spawn(store, TOKEN).await;
    let req = Request::builder()
        .uri("/streams/stats")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap();
    let (status, body) = call(addr, req).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["entries"], 1);
    assert_eq!(body["quota"], 10);
}

/// Shape da rota com os contadores do cache (`stream.cache.*`). O global é
/// POR PROCESSO e este binário também roda os testes de rota `/stream` em
/// paralelo (cada `handle` é um miss) — valor absoluto não é afirmável. A
/// régua: o reportado fica ENTRE dois snapshots (contador monótono) e o
/// `hitRate` é a fração servida, `null` sem NENHUMA consulta.
#[tokio::test]
async fn stats_expoe_contadores_do_cache_e_hit_rate() {
    use adom_search::orchestrator::stream_cache_metrics;

    let store = Arc::new(StreamsStore::open_memory_with_quota(10).unwrap());
    let addr = spawn(store, TOKEN).await;
    let req = Request::builder()
        .uri("/streams/stats")
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap();
    let antes = adom_search::orchestrator::stream_cache_metrics_snapshot();
    let (status, body) = call(addr, req).await;
    let depois = adom_search::orchestrator::stream_cache_metrics_snapshot();

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["entries"], 0);
    assert_eq!(body["quota"], 10);
    for (key, campo) in [
        (stream_cache_metrics::HIT, "hit"),
        (stream_cache_metrics::STALE_SERVED, "staleServed"),
        (stream_cache_metrics::MISS, "miss"),
        (stream_cache_metrics::WRITE, "writes"),
    ] {
        let valor = body[campo]
            .as_u64()
            .unwrap_or_else(|| panic!("{campo} numérico: {body}"));
        assert!(
            valor >= antes.get(key).copied().unwrap_or(0)
                && valor <= depois.get(key).copied().unwrap_or(0),
            "{campo}={valor} fora de [{:?}, {:?}]",
            antes.get(key),
            depois.get(key)
        );
    }
    let hit = body["hit"].as_u64().unwrap_or(0);
    let stale = body["staleServed"].as_u64().unwrap_or(0);
    let miss = body["miss"].as_u64().unwrap_or(0);
    let servidos = hit + stale;
    let total = servidos + miss;
    let esperado = if total == 0 {
        Value::Null
    } else {
        json!(servidos as f64 / total as f64)
    };
    assert_eq!(
        body["hitRate"], esperado,
        "hitRate coerente com os contadores reportados"
    );
}
